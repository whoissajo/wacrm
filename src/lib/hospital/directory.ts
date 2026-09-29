import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText,
} from "@/lib/flows/meta-send";
import { FLOW_AI_HANDOFF_MARKER } from "@/lib/flows/types";

const ACCOUNT_ID_RE = /^[0-9a-f-]{36}$/i;
const MAX_PAGE_SIZE = 7;

export type HospitalInbound =
  | { kind: "text"; text: string; metaMessageId?: string }
  | { kind: "interactive_reply"; replyId: string; replyTitle: string; metaMessageId?: string };

export interface HospitalDispatchArgs {
  accountId: string;
  userId: string;
  contactId: string;
  conversationId: string;
  message: HospitalInbound;
}

export interface HospitalDispatchResult {
  consumed: boolean;
  outcome:
    | "menu"
    | "department_list"
    | "doctor_list"
    | "doctor_detail"
    | "booking_started"
    | "appointment_saved"
    | "hospital_info"
    | "ai_handoff"
    | "human_handoff"
    | "no_match";
}

interface HospitalSession {
  id: string;
  state: string;
  department_id: string | null;
  doctor_id: string | null;
  page: number;
  mode: "directory" | "booking";
  appointment_step: "date" | "time" | "name" | "submitted" | null;
  appointment_data: Record<string, unknown>;
}

interface Department {
  id: string;
  name: string;
  short_name: string;
  sort_order: number;
}

interface Doctor {
  id: string;
  display_name: string;
  appointment_phone: string | null;
  location: string | null;
  notes: string | null;
  sort_order: number;
}

interface Schedule {
  days_of_week: number[];
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
}

const TRIGGERS = new Set([
  "hi",
  "hello",
  "salam",
  "assalamualaikum",
  "menu",
  "find a doctor",
  "find doctor",
  "book appointment",
  "appointment",
]);

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[’']/g, "");
}

function isHospitalTrigger(text: string): boolean {
  return TRIGGERS.has(normalize(text));
}

function looksLikeMenu(text: string): boolean {
  const value = normalize(text);
  return value === "back" || value === "main menu" || value === "menu";
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dayLabel(day: number): string {
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][day] ?? "Day";
}

function formatTime(value: string | null): string {
  if (!value) return "Time not listed";
  const [h, m] = value.slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return value.slice(0, 5);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatSchedule(schedule: Schedule): string {
  const days = (schedule.days_of_week ?? []).map(dayLabel).join(", ");
  const start = formatTime(schedule.start_time);
  const end = schedule.end_time ? formatTime(schedule.end_time) : "onward";
  const note = schedule.notes ? ` — ${schedule.notes}` : "";
  return `${days}: ${start} to ${end}${note}`;
}

function pageSlice<T>(items: T[], page: number): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / MAX_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  return {
    rows: items.slice(safePage * MAX_PAGE_SIZE, safePage * MAX_PAGE_SIZE + MAX_PAGE_SIZE),
    page: safePage,
    pageCount,
  };
}

async function getSession(db: ReturnType<typeof supabaseAdmin>, conversationId: string): Promise<HospitalSession | null> {
  const { data } = await db
    .from("hospital_directory_sessions")
    .select("id,state,department_id,doctor_id,page,mode,appointment_step,appointment_data")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data as HospitalSession | null) ?? null;
}

async function upsertSession(
  db: ReturnType<typeof supabaseAdmin>,
  args: Partial<HospitalSession> & { accountId: string; conversationId: string },
): Promise<HospitalSession | null> {
  const current = await getSession(db, args.conversationId);
  const payload = {
    account_id: args.accountId,
    conversation_id: args.conversationId,
    state: args.state ?? current?.state ?? "main",
    department_id: args.department_id ?? current?.department_id ?? null,
    doctor_id: args.doctor_id ?? current?.doctor_id ?? null,
    page: args.page ?? current?.page ?? 0,
    mode: args.mode ?? current?.mode ?? "directory",
    appointment_step: args.appointment_step ?? current?.appointment_step ?? null,
    appointment_data: args.appointment_data ?? current?.appointment_data ?? {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("hospital_directory_sessions")
    .upsert(payload, { onConflict: "conversation_id" })
    .select("id,state,department_id,doctor_id,page,mode,appointment_step,appointment_data")
    .single();
  if (error) {
    console.error("[hospital] session upsert failed:", error);
    return null;
  }
  return data as HospitalSession;
}

async function clearSession(db: ReturnType<typeof supabaseAdmin>, conversationId: string): Promise<void> {
  await db.from("hospital_directory_sessions").delete().eq("conversation_id", conversationId);
}

async function getSettings(db: ReturnType<typeof supabaseAdmin>, accountId: string) {
  const { data } = await db
    .from("hospital_settings")
    .select("hospital_name,welcome_text,uan_phone,appointment_note,is_active")
    .eq("account_id", accountId)
    .maybeSingle();
  return data;
}

async function listDepartments(db: ReturnType<typeof supabaseAdmin>, accountId: string): Promise<Department[]> {
  const { data, error } = await db
    .from("hospital_departments")
    .select("id,name,short_name,sort_order")
    .eq("account_id", accountId)
    .eq("is_active", true)
    .order("sort_order");
  if (error) {
    console.error("[hospital] departments query failed:", error);
    return [];
  }
  return (data ?? []) as Department[];
}

async function listDoctors(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  departmentId: string,
): Promise<Doctor[]> {
  const { data, error } = await db
    .from("hospital_doctor_departments")
    .select("sort_order, hospital_doctors!inner(id,display_name,appointment_phone,location,notes,sort_order,account_id,is_active)")
    .eq("department_id", departmentId)
    .eq("hospital_doctors.account_id", accountId)
    .eq("hospital_doctors.is_active", true)
    .order("sort_order");
  if (error) {
    console.error("[hospital] doctors query failed:", error);
    return [];
  }
  return (data ?? [])
    .map((row: any) => ({ ...(row.hospital_doctors as Doctor), sort_order: row.sort_order ?? row.hospital_doctors.sort_order }))
    .sort((a: Doctor, b: Doctor) => a.sort_order - b.sort_order);
}

async function getDoctor(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  doctorId: string,
): Promise<Doctor | null> {
  const { data } = await db
    .from("hospital_doctors")
    .select("id,display_name,appointment_phone,location,notes,sort_order")
    .eq("id", doctorId)
    .eq("account_id", accountId)
    .eq("is_active", true)
    .maybeSingle();
  return (data as Doctor | null) ?? null;
}

async function getDoctorSchedules(
  db: ReturnType<typeof supabaseAdmin>,
  doctorId: string,
): Promise<Schedule[]> {
  const { data, error } = await db
    .from("hospital_doctor_schedules")
    .select("days_of_week,start_time,end_time,notes")
    .eq("doctor_id", doctorId)
    .eq("is_active", true)
    .order("id");
  if (error) {
    console.error("[hospital] schedule query failed:", error);
    return [];
  }
  return (data ?? []) as Schedule[];
}

async function sendHospitalText(
  args: { accountId: string; userId: string; contactId: string; conversationId: string; text: string },
): Promise<void> {
  await engineSendText(args);
}

async function showMainMenu(args: HospitalDispatchArgs): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  const settings = await getSettings(db, args.accountId);
  if (!settings?.is_active) return { consumed: false, outcome: "no_match" };

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: "main",
    department_id: null,
    doctor_id: null,
    page: 0,
    mode: "directory",
    appointment_step: null,
    appointment_data: {},
  });

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: settings.welcome_text ?? `Welcome to ${settings.hospital_name}.`,
    buttonLabel: "Choose an option",
    sections: [{
      title: "Hospital Assistance",
      rows: [
        { id: "hospital:find_doctor", title: "Find a Doctor", description: "Browse departments and doctor timings" },
        { id: "hospital:book", title: "Book Appointment", description: "Send an appointment request" },
        { id: "hospital:info", title: "Hospital Information", description: "Phone and patient information" },
        { id: "hospital:ai", title: "Talk to AI", description: "Ask the hospital assistant a question" },
        { id: "hospital:reception", title: "Talk to Reception", description: "Connect with the reception team" },
      ],
    }],
  });
  return { consumed: true, outcome: "menu" };
}

async function showDepartments(args: HospitalDispatchArgs, page = 0, mode: "directory" | "booking" = "directory"): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  const departments = await listDepartments(db, args.accountId);
  const p = pageSlice(departments, page);
  const rows = p.rows.map((d) => ({
    id: `hospital:dept:${d.id}`,
    title: d.short_name.slice(0, 24),
    description: d.name,
  }));
  if (p.page > 0) rows.push({ id: `hospital:dept_prev:${p.page - 1}`, title: "Previous", description: "Previous departments" });
  if (p.page < p.pageCount - 1) rows.push({ id: `hospital:dept_next:${p.page + 1}`, title: "Next", description: "More departments" });
  rows.push({ id: "hospital:main", title: "Main Menu", description: "Return to hospital menu" });

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: mode === "booking" ? "booking_department" : "departments",
    page: p.page,
    mode,
    department_id: null,
    doctor_id: null,
    appointment_step: null,
    appointment_data: {},
  });

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: mode === "booking" ? "Select the department for the appointment:" : "Select a department:",
    buttonLabel: "Departments",
    sections: [{ title: `Page ${p.page + 1} of ${p.pageCount}`, rows }],
  });
  return { consumed: true, outcome: "department_list" };
}

async function showDoctors(
  args: HospitalDispatchArgs,
  departmentId: string,
  page = 0,
  mode: "directory" | "booking" = "directory",
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  const [departments, doctors] = await Promise.all([
    listDepartments(db, args.accountId),
    listDoctors(db, args.accountId, departmentId),
  ]);
  const department = departments.find((d) => d.id === departmentId);
  if (!department) return showDepartments(args, 0, mode);

  const p = pageSlice(doctors, page);
  const rows = p.rows.map((doctor) => ({
    id: `hospital:doctor:${doctor.id}`,
    title: doctor.display_name.slice(0, 24),
    description: doctor.location ?? "View consultation timings",
  }));
  if (p.page > 0) rows.push({ id: `hospital:doctor_prev:${departmentId}:${p.page - 1}`, title: "Previous", description: "Previous doctors" });
  if (p.page < p.pageCount - 1) rows.push({ id: `hospital:doctor_next:${departmentId}:${p.page + 1}`, title: "Next", description: "More doctors" });
  rows.push({ id: "hospital:dept_change", title: "Change Department", description: "Choose another department" });

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: mode === "booking" ? "booking_doctor" : "doctors",
    department_id: departmentId,
    doctor_id: null,
    page: p.page,
    mode,
    appointment_step: null,
    appointment_data: {},
  });

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: `${department.name}: select a doctor.`,
    buttonLabel: "Doctors",
    sections: [{ title: `Page ${p.page + 1} of ${p.pageCount}`, rows }],
  });
  return { consumed: true, outcome: "doctor_list" };
}

async function showDoctorDetail(
  args: HospitalDispatchArgs,
  doctorId: string,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  const doctor = await getDoctor(db, args.accountId, doctorId);
  if (!doctor) return { consumed: true, outcome: "no_match" };

  const session = await getSession(db, args.conversationId);
  if (session?.mode === "booking") {
    await upsertSession(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      state: "appointment",
      doctor_id: doctorId,
      appointment_step: "date",
      appointment_data: {},
    });
    await sendHospitalText({
      accountId: args.accountId,
      userId: args.userId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      text: `Appointment request for ${doctor.display_name}. What date would you prefer?\nPlease use DD/MM/YYYY.`,
    });
    return { consumed: true, outcome: "booking_started" };
  }

  const schedules = await getDoctorSchedules(db, doctorId);
  const scheduleText = schedules.length
    ? schedules.map(formatSchedule).join("\n")
    : "Exact consultation timing is not listed in the source schedule. Please call the hospital before booking.";
  const extra = [
    doctor.location ? `Location: ${doctor.location}` : "",
    doctor.appointment_phone ? `Appointment contact: ${doctor.appointment_phone}` : "",
    doctor.notes ?? "",
  ].filter(Boolean).join("\n");

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: "doctor_detail",
    doctor_id: doctorId,
  });

  await sendHospitalText({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    text: `Dr. ${doctor.display_name.replace(/^Dr\.\s*/i, "")}\n\nConsultation timings:\n${scheduleText}${extra ? `\n\n${extra}` : ""}`,
  });

  await engineSendInteractiveButtons({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: "What would you like to do next?",
    buttons: [
      { id: "hospital:other_doctor", title: "Other Doctor" },
      { id: "hospital:book_current", title: "Book Appointment" },
      { id: "hospital:dept_change", title: "Change Department" },
    ],
  });
  return { consumed: true, outcome: "doctor_detail" };
}

function parseDate(value: string): string | null {
  const v = normalize(value);
  if (v === "today" || v === "tomorrow") {
    const d = new Date();
    if (v === "tomorrow") d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTime(value: string): string | null {
  const v = normalize(value).replace(/\./g, ":");
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const minute = Number(m[2] ?? "00");
  const ap = m[3];
  if (minute > 59 || h > 23) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

async function humanHandoff(args: HospitalDispatchArgs, message: string): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  await clearSession(db, args.conversationId);
  await db
    .from("conversations")
    .update({
      status: "pending",
      ai_autoreply_disabled: true,
      ai_handoff_summary: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.conversationId)
    .eq("account_id", args.accountId);
  await sendHospitalText({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    text: message,
  });
  return { consumed: true, outcome: "human_handoff" };
}

async function aiHandoff(args: HospitalDispatchArgs): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  await clearSession(db, args.conversationId);
  await db
    .from("conversations")
    .update({
      status: "pending",
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_handoff_summary: FLOW_AI_HANDOFF_MARKER,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.conversationId)
    .eq("account_id", args.accountId);
  await sendHospitalText({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    text: "You’re connected to the hospital AI assistant. You can ask about doctors, consultation timings, departments, appointment requests, or hospital information.",
  });
  return { consumed: true, outcome: "ai_handoff" };
}

async function saveAppointment(
  args: HospitalDispatchArgs,
  session: HospitalSession,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin();
  const doctorId = session.doctor_id;
  const data = session.appointment_data;
  const requestedDate = safeString(data.date);
  const requestedTime = safeString(data.time);
  const patientName = safeString(data.name).trim();
  if (!patientName) return { consumed: true, outcome: "no_match" };

  const { error } = await db.from("hospital_appointment_requests").insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    doctor_id: doctorId,
    patient_name: patientName,
    requested_date: requestedDate || null,
    requested_time: requestedTime || null,
    status: "pending",
  });
  if (error) {
    console.error("[hospital] appointment insert failed:", error);
    await sendHospitalText({
      accountId: args.accountId,
      userId: args.userId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      text: "I could not save the appointment request right now. Please contact reception.",
    });
    return { consumed: true, outcome: "human_handoff" };
  }

  await clearSession(db, args.conversationId);
  await db
    .from("conversations")
    .update({
      status: "pending",
      ai_autoreply_disabled: true,
      ai_handoff_summary: "Hospital appointment request submitted; reception must confirm the appointment.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.conversationId)
    .eq("account_id", args.accountId);

  const doctor = doctorId ? await getDoctor(db, args.accountId, doctorId) : null;
  const settings = await getSettings(db, args.accountId);
  await sendHospitalText({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    text:
      `✅ Appointment request received.\n\nDoctor: ${doctor?.display_name ?? "To be assigned"}\nPatient: ${patientName}\nPreferred date: ${requestedDate || "Not specified"}\nPreferred time: ${requestedTime ? formatTime(requestedTime) : "Not specified"}\n\nThis is a request, not a confirmed appointment. Reception will confirm it.${settings?.uan_phone ? `\n\nHospital: ${settings.uan_phone}` : ""}`,
  });
  return { consumed: true, outcome: "appointment_saved" };
}

async function handleTextInSession(args: HospitalDispatchArgs, session: HospitalSession): Promise<HospitalDispatchResult> {
  const text = safeString(args.message.kind === "text" ? args.message.text : "");
  if (!text) return { consumed: true, outcome: "no_match" };
  if (looksLikeMenu(text)) return showMainMenu(args);

  if (session.state === "appointment") {
    if (session.appointment_step === "date") {
      const date = parseDate(text);
      if (!date) {
        await sendHospitalText({ accountId: args.accountId, userId: args.userId, contactId: args.contactId, conversationId: args.conversationId, text: "Please enter the date as DD/MM/YYYY, for example 05/10/2026." });
        return { consumed: true, outcome: "booking_started" };
      }
      await upsertSession(supabaseAdmin(), { accountId: args.accountId, conversationId: args.conversationId, appointment_step: "time", appointment_data: { ...session.appointment_data, date } });
      await sendHospitalText({ accountId: args.accountId, userId: args.userId, contactId: args.contactId, conversationId: args.conversationId, text: "What time would you prefer? For example 06:30 PM." });
      return { consumed: true, outcome: "booking_started" };
    }
    if (session.appointment_step === "time") {
      const time = parseTime(text);
      if (!time) {
        await sendHospitalText({ accountId: args.accountId, userId: args.userId, contactId: args.contactId, conversationId: args.conversationId, text: "Please enter a valid time, for example 06:30 PM." });
        return { consumed: true, outcome: "booking_started" };
      }
      await upsertSession(supabaseAdmin(), { accountId: args.accountId, conversationId: args.conversationId, appointment_step: "name", appointment_data: { ...session.appointment_data, time } });
      await sendHospitalText({ accountId: args.accountId, userId: args.userId, contactId: args.contactId, conversationId: args.conversationId, text: "What is the patient's full name?" });
      return { consumed: true, outcome: "booking_started" };
    }
    if (session.appointment_step === "name") {
      const name = text.trim();
      if (name.length < 2) {
        await sendHospitalText({ accountId: args.accountId, userId: args.userId, contactId: args.contactId, conversationId: args.conversationId, text: "Please enter the patient's full name." });
        return { consumed: true, outcome: "booking_started" };
      }
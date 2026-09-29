import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText,
} from '@/lib/flows/meta-send'
import { FLOW_AI_HANDOFF_MARKER } from '@/lib/flows/types'

const MAX_PAGE_SIZE = 7
const ACCOUNT_ID_RE = /^[0-9a-f-]{36}$/i

export type HospitalInbound =
  | { kind: 'text'; text: string; metaMessageId?: string }
  | {
      kind: 'interactive_reply'
      replyId: string
      replyTitle: string
      metaMessageId?: string
    }

export interface HospitalDispatchArgs {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  message: HospitalInbound
}

export interface HospitalDispatchResult {
  consumed: boolean
  outcome:
    | 'menu'
    | 'department_list'
    | 'doctor_list'
    | 'doctor_detail'
    | 'booking_started'
    | 'appointment_saved'
    | 'hospital_info'
    | 'ai_handoff'
    | 'human_handoff'
    | 'no_match'
}

interface HospitalSession {
  id: string
  state: string
  department_id: string | null
  doctor_id: string | null
  page: number
  mode: 'directory' | 'booking'
  appointment_step: 'date' | 'time' | 'name' | 'submitted' | null
  appointment_data: Record<string, unknown>
}

interface HospitalSettings {
  hospital_name: string
  welcome_text: string | null
  uan_phone: string | null
  appointment_note: string | null
  is_active: boolean
}

interface Department {
  id: string
  name: string
  short_name: string
  sort_order: number
}

interface Doctor {
  id: string
  display_name: string
  appointment_phone: string | null
  location: string | null
  notes: string | null
  sort_order: number
}

interface Schedule {
  days_of_week: number[]
  start_time: string | null
  end_time: string | null
  notes: string | null
}

interface DepartmentLink {
  doctor_id: string
  department_id: string
  sort_order: number
}

const TRIGGERS = new Set([
  'hi',
  'hello',
  'salam',
  'assalamualaikum',
  'menu',
  'find a doctor',
  'find doctor',
  'book appointment',
  'appointment',
])

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[’']/g, '')
}

function isHospitalTrigger(text: string): boolean {
  return TRIGGERS.has(normalize(text))
}

function isMainMenuText(text: string): boolean {
  const value = normalize(text)
  return value === 'back' || value === 'main menu' || value === 'menu'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function dayLabel(day: number): string {
  return (
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day] ??
    'Day'
  )
}

function formatTime(value: string | null): string {
  if (!value) return 'Time not listed'
  const [hoursText, minutesText] = value.slice(0, 5).split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return value.slice(0, 5)
  }
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const hour = hours % 12 || 12
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`
}

function formatSchedule(schedule: Schedule): string {
  const days = schedule.days_of_week.map(dayLabel).join(', ')
  const start = formatTime(schedule.start_time)
  const end = schedule.end_time ? formatTime(schedule.end_time) : 'onward'
  const note = schedule.notes ? ` — ${schedule.notes}` : ''
  return `${days}: ${start} to ${end}${note}`
}

function pageSlice<T>(items: T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / MAX_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), pageCount - 1)
  return {
    rows: items.slice(safePage * MAX_PAGE_SIZE, safePage * MAX_PAGE_SIZE + MAX_PAGE_SIZE),
    page: safePage,
    pageCount,
  }
}

async function getSession(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<HospitalSession | null> {
  const { data } = await db
    .from('hospital_directory_sessions')
    .select(
      'id,state,department_id,doctor_id,page,mode,appointment_step,appointment_data',
    )
    .eq('conversation_id', conversationId)
    .maybeSingle()

  return (data as HospitalSession | null) ?? null
}

async function upsertSession(
  db: ReturnType<typeof supabaseAdmin>,
  args: Partial<HospitalSession> & {
    accountId: string
    conversationId: string
  },
): Promise<HospitalSession | null> {
  const current = await getSession(db, args.conversationId)
  const payload = {
    account_id: args.accountId,
    conversation_id: args.conversationId,
    state: args.state ?? current?.state ?? 'main',
    department_id: args.department_id ?? current?.department_id ?? null,
    doctor_id: args.doctor_id ?? current?.doctor_id ?? null,
    page: args.page ?? current?.page ?? 0,
    mode: args.mode ?? current?.mode ?? 'directory',
    appointment_step: args.appointment_step ?? current?.appointment_step ?? null,
    appointment_data: args.appointment_data ?? current?.appointment_data ?? {},
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await db
    .from('hospital_directory_sessions')
    .upsert(payload, { onConflict: 'conversation_id' })
    .select(
      'id,state,department_id,doctor_id,page,mode,appointment_step,appointment_data',
    )
    .single()

  if (error) {
    console.error('[hospital] session upsert failed:', error)
    return null
  }

  return data as HospitalSession
}

async function clearSession(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<void> {
  await db
    .from('hospital_directory_sessions')
    .delete()
    .eq('conversation_id', conversationId)
}

async function getSettings(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<HospitalSettings | null> {
  const { data } = await db
    .from('hospital_settings')
    .select('hospital_name,welcome_text,uan_phone,appointment_note,is_active')
    .eq('account_id', accountId)
    .maybeSingle()

  return (data as HospitalSettings | null) ?? null
}

async function listDepartments(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<Department[]> {
  const { data, error } = await db
    .from('hospital_departments')
    .select('id,name,short_name,sort_order')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('sort_order')

  if (error) {
    console.error('[hospital] departments query failed:', error)
    return []
  }

  return (data as Department[] | null) ?? []
}

async function listDoctors(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  departmentId: string,
): Promise<Doctor[]> {
  const { data: linksData, error: linksError } = await db
    .from('hospital_doctor_departments')
    .select('doctor_id,department_id,sort_order')
    .eq('department_id', departmentId)
    .order('sort_order')

  if (linksError || !linksData) {
    console.error('[hospital] department links query failed:', linksError)
    return []
  }

  const links = (linksData as DepartmentLink[])
  const ids = links.map((link) => link.doctor_id)
  if (ids.length === 0) return []

  const { data: doctorData, error: doctorError } = await db
    .from('hospital_doctors')
    .select(
      'id,display_name,appointment_phone,location,notes,sort_order,account_id,is_active',
    )
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('id', ids)

  if (doctorError || !doctorData) {
    console.error('[hospital] doctors query failed:', doctorError)
    return []
  }

  const doctors = (doctorData as Doctor[]).map((doctor) => ({
    ...doctor,
    sort_order:
      links.find((link) => link.doctor_id === doctor.id)?.sort_order ??
      doctor.sort_order,
  }))

  return doctors.sort((a, b) => a.sort_order - b.sort_order)
}

async function getDoctor(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  doctorId: string,
): Promise<Doctor | null> {
  const { data } = await db
    .from('hospital_doctors')
    .select('id,display_name,appointment_phone,location,notes,sort_order')
    .eq('id', doctorId)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .maybeSingle()

  return (data as Doctor | null) ?? null
}

async function getDoctorSchedules(
  db: ReturnType<typeof supabaseAdmin>,
  doctorId: string,
): Promise<Schedule[]> {
  const { data, error } = await db
    .from('hospital_doctor_schedules')
    .select('days_of_week,start_time,end_time,notes')
    .eq('doctor_id', doctorId)
    .eq('is_active', true)
    .order('id')

  if (error || !data) {
    console.error('[hospital] schedule query failed:', error)
    return []
  }

  return (data as Schedule[]).filter((schedule) => schedule.days_of_week.length > 0)
}

async function sendHospitalText(
  args: HospitalDispatchArgs,
  text: string,
): Promise<void> {
  await engineSendText({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    text,
  })
}

async function showMainMenu(
  args: HospitalDispatchArgs,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  const settings = await getSettings(db, args.accountId)
  if (!settings?.is_active) return { consumed: false, outcome: 'no_match' }

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: 'main',
    department_id: null,
    doctor_id: null,
    page: 0,
    mode: 'directory',
    appointment_step: null,
    appointment_data: {},
  })

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText:
      settings.welcome_text ??
      `Welcome to ${settings.hospital_name}. Please choose an option below.`,
    buttonLabel: 'Hospital Menu',
    sections: [
      {
        title: 'Hospital Assistance',
        rows: [
          {
            id: 'hospital:find_doctor',
            title: 'Find a Doctor',
            description: 'Browse departments and doctor timings',
          },
          {
            id: 'hospital:book',
            title: 'Book Appointment',
            description: 'Send an appointment request',
          },
          {
            id: 'hospital:info',
            title: 'Hospital Information',
            description: 'Phone and patient information',
          },
          {
            id: 'hospital:ai',
            title: 'Talk to AI',
            description: 'Ask the hospital assistant a question',
          },
          {
            id: 'hospital:reception',
            title: 'Talk to Reception',
            description: 'Connect with the reception team',
          },
        ],
      },
    ],
  })

  return { consumed: true, outcome: 'menu' }
}

async function showDepartments(
  args: HospitalDispatchArgs,
  page = 0,
  mode: 'directory' | 'booking' = 'directory',
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  const departments = await listDepartments(db, args.accountId)
  const pageData = pageSlice(departments, page)

  const rows = pageData.rows.map((department) => ({
    id: `hospital:dept:${department.id}`,
    title: department.short_name.slice(0, 24),
    description: department.name.slice(0, 72),
  }))

  if (pageData.page > 0) {
    rows.push({
      id: `hospital:dept_prev:${pageData.page - 1}`,
      title: 'Previous',
      description: 'Previous departments',
    })
  }
  if (pageData.page < pageData.pageCount - 1) {
    rows.push({
      id: `hospital:dept_next:${pageData.page + 1}`,
      title: 'Next',
      description: 'More departments',
    })
  }
  rows.push({
    id: 'hospital:main',
    title: 'Main Menu',
    description: 'Return to hospital menu',
  })

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: mode === 'booking' ? 'booking_department' : 'departments',
    department_id: null,
    doctor_id: null,
    page: pageData.page,
    mode,
    appointment_step: null,
    appointment_data: {},
  })

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText:
      mode === 'booking'
        ? 'Select the department for the appointment:'
        : 'Select a department:',
    buttonLabel: 'Departments',
    sections: [
      {
        title: `Page ${pageData.page + 1} of ${pageData.pageCount}`,
        rows,
      },
    ],
  })

  return { consumed: true, outcome: 'department_list' }
}

async function showDoctors(
  args: HospitalDispatchArgs,
  departmentId: string,
  page = 0,
  mode: 'directory' | 'booking' = 'directory',
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  const [departments, doctors] = await Promise.all([
    listDepartments(db, args.accountId),
    listDoctors(db, args.accountId, departmentId),
  ])

  const department = departments.find((item) => item.id === departmentId)
  if (!department) return showDepartments(args, 0, mode)

  const pageData = pageSlice(doctors, page)
  const rows = pageData.rows.map((doctor) => ({
    id: `hospital:doctor:${doctor.id}`,
    title: doctor.display_name.slice(0, 24),
    description: (doctor.location ?? 'View consultation timings').slice(0, 72),
  }))

  if (pageData.page > 0) {
    rows.push({
      id: `hospital:doctor_prev:${departmentId}:${pageData.page - 1}`,
      title: 'Previous',
      description: 'Previous doctors',
    })
  }
  if (pageData.page < pageData.pageCount - 1) {
    rows.push({
      id: `hospital:doctor_next:${departmentId}:${pageData.page + 1}`,
      title: 'Next',
      description: 'More doctors',
    })
  }
  rows.push({
    id: 'hospital:dept_change',
    title: 'Change Department',
    description: 'Choose another department',
  })

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: mode === 'booking' ? 'booking_doctor' : 'doctors',
    department_id: departmentId,
    doctor_id: null,
    page: pageData.page,
    mode,
    appointment_step: null,
    appointment_data: {},
  })

  await engineSendInteractiveList({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: `${department.name}: select a doctor.`,
    buttonLabel: 'Doctors',
    sections: [
      {
        title: `Page ${pageData.page + 1} of ${pageData.pageCount}`,
        rows,
      },
    ],
  })

  return { consumed: true, outcome: 'doctor_list' }
}

async function showDoctor(
  args: HospitalDispatchArgs,
  doctorId: string,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  const doctor = await getDoctor(db, args.accountId, doctorId)
  if (!doctor) return { consumed: true, outcome: 'no_match' }

  const session = await getSession(db, args.conversationId)
  if (session?.mode === 'booking') {
    await upsertSession(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      state: 'appointment',
      doctor_id: doctor.id,
      appointment_step: 'date',
      appointment_data: {},
    })
    await sendHospitalText(
      args,
      `Appointment request for ${doctor.display_name}. What date would you prefer?\nPlease use DD/MM/YYYY.`,
    )
    return { consumed: true, outcome: 'booking_started' }
  }

  const schedules = await getDoctorSchedules(db, doctor.id)
  const scheduleText = schedules.length
    ? schedules.map(formatSchedule).join('\n')
    : 'Exact consultation timing is not listed in the source schedule. Please call the hospital before booking.'

  const extra = [
    doctor.location ? `Location: ${doctor.location}` : '',
    doctor.appointment_phone
      ? `Appointment contact: ${doctor.appointment_phone}`
      : '',
    doctor.notes ?? '',
  ]
    .filter(Boolean)
    .join('\n')

  await upsertSession(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    state: 'doctor_detail',
    department_id: session?.department_id ?? null,
    doctor_id: doctor.id,
    page: session?.page ?? 0,
    mode: 'directory',
  })

  await sendHospitalText(
    args,
    `${doctor.display_name}\n\nConsultation timings:\n${scheduleText}${extra ? `\n\n${extra}` : ''}`,
  )

  await engineSendInteractiveButtons({
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    bodyText: 'What would you like to do next?',
    buttons: [
      { id: 'hospital:other_doctor', title: 'Other Doctor' },
      { id: 'hospital:book_current', title: 'Book Appointment' },
      { id: 'hospital:dept_change', title: 'Change Department' },
    ],
  })

  return { consumed: true, outcome: 'doctor_detail' }
}

function parseDate(value: string): string | null {
  const normalized = normalize(value)
  if (normalized === 'today' || normalized === 'tomorrow') {
    const date = new Date()
    if (normalized === 'tomorrow') date.setDate(date.getDate() + 1)
    return date.toISOString().slice(0, 10)
  }

  const match = normalized.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/)
  if (!match) return null

  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseTime(value: string): string | null {
  const normalized = normalize(value).replace(/\./g, ':')
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!match) return null

  let hours = Number(match[1])
  const minutes = Number(match[2] ?? '00')
  const meridiem = match[3]

  if (minutes > 59 || hours > 23) return null
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (hours > 23) return null

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
}

async function humanHandoff(
  args: HospitalDispatchArgs,
  message: string,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  await clearSession(db, args.conversationId)
  await db
    .from('conversations')
    .update({
      status: 'pending',
      ai_autoreply_disabled: true,
      ai_handoff_summary: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  await sendHospitalText(args, message)
  return { consumed: true, outcome: 'human_handoff' }
}

async function aiHandoff(
  args: HospitalDispatchArgs,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  await clearSession(db, args.conversationId)
  await db
    .from('conversations')
    .update({
      status: 'pending',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_handoff_summary: FLOW_AI_HANDOFF_MARKER,
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  await sendHospitalText(
    args,
    'You’re connected to the hospital AI assistant. You can ask about doctors, consultation timings, departments, appointment requests, or hospital information.',
  )
  return { consumed: true, outcome: 'ai_handoff' }
}

async function saveAppointment(
  args: HospitalDispatchArgs,
  session: HospitalSession,
): Promise<HospitalDispatchResult> {
  const db = supabaseAdmin()
  const patientName = stringValue(session.appointment_data.name).trim()
  if (!patientName) return { consumed: true, outcome: 'no_match' }

  const requestedDate = stringValue(session.appointment_data.date)
  const requestedTime = stringValue(session.appointment_data.time)

  const { error } = await db.from('hospital_appointment_requests').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    doctor_id: session.doctor_id,
    patient_name: patientName,
    requested_date: requestedDate || null,
    requested_time: requestedTime || null,
    status: 'pending',
  })

  if (error) {
    console.error('[hospital] appointment insert failed:', error)
    await sendHospitalText(
      args,
      'I could not save the appointment request right now. Please contact reception.',
    )
    return { consumed: true, outcome: 'human_handoff' }
  }

  await clearSession(db, args.conversationId)
  await db
    .from('conversations')
    .update({
      status: 'pending',
      ai_autoreply_disabled: true,
      ai_handoff_summary:
        'Hospital appointment request submitted; reception must confirm the appointment.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  const doctor = session.doctor_id
    ? await getDoctor(db, args.accountId, session.doctor_id)
    : null
  const settings = await getSettings(db, args.accountId)

  await sendHospitalText(
    args,
    `✅ Appointment request received.\n\nDoctor: ${doctor?.display_name ?? 'To be assigned'}\nPatient: ${patientName}\nPreferred date: ${requestedDate || 'Not specified'}\nPreferred time: ${requestedTime ? formatTime(requestedTime) : 'Not specified'}\n\nThis is a request, not a confirmed appointment. Reception will confirm it.${settings?.uan_phone ? `\n\nHospital: ${settings.uan_phone}` : ''}`,
  )

  return { consumed: true, outcome: 'appointment_saved' }
}

async function handleSessionText(
  args: HospitalDispatchArgs,
  session: HospitalSession,
): Promise<HospitalDispatchResult> {
  if (args.message.kind !== 'text') {
    return { consumed: true, outcome: 'no_match' }
  }

  const text = args.message.text.trim()
  if (!text) return { consumed: true, outcome: 'no_match' }
  if (isMainMenuText(text)) return showMainMenu(args)

  if (session.state === 'appointment') {
    if (session.appointment_step === 'date') {
      const date = parseDate(text)
      if (!date) {
        await sendHospitalText(
          args,
          'Please enter the date as DD/MM/YYYY, for example 05/10/2026.',
        )
        return { consumed: true, outcome: 'booking_started' }
      }

      await upsertSession(supabaseAdmin(), {
        accountId: args.accountId,
        conversationId: args.conversationId,
        appointment_step: 'time',
        appointment_data: { ...session.appointment_data, date },
      })
      await sendHospitalText(args, 'What time would you prefer? For example 06:30 PM.')
      return { consumed: true, outcome: 'booking_started' }
    }

    if (session.appointment_step === 'time') {
      const time = parseTime(text)
      if (!time) {
        await sendHospitalText(
          args,
          'Please enter a valid time, for example 06:30 PM.',
        )
        return { consumed: true, outcome: 'booking_started' }
      }

      await upsertSession(supabaseAdmin(), {
        accountId: args.accountId,
        conversationId: args.conversationId,
        appointment_step: 'name',
        appointment_data: { ...session.appointment_data, time },
      })
      await sendHospitalText(args, "What is the patient's full name?")
      return { consumed: true, outcome: 'booking_started' }
    }

    if (session.appointment_step === 'name') {
      const name = text.trim()
      if (name.length < 2) {
        await sendHospitalText(args, "Please enter the patient's full name.")
        return { consumed: true, outcome: 'booking_started' }
      }

      const next = await upsertSession(supabaseAdmin(), {
        accountId: args.accountId,
        conversationId: args.conversationId,
        appointment_step: 'submitted',
        appointment_data: { ...session.appointment_data, name },
      })
      if (!next) return { consumed: true, outcome: 'human_handoff' }
      return saveAppointment(args, next)
    }
  }

  if (session.state === 'departments') {
    return showDepartments(args, session.page, 'directory')
  }
  if (session.state === 'doctors' && session.department_id) {
    return showDoctors(args, session.department_id, session.page, 'directory')
  }
  if (session.state === 'booking_department') {
    return showDepartments(args, session.page, 'booking')
  }
  if (session.state === 'booking_doctor' && session.department_id) {
    return showDoctors(args, session.department_id, session.page, 'booking')
  }

  return showMainMenu(args)
}

async function handleInteractive(
  args: HospitalDispatchArgs,
  session: HospitalSession | null,
): Promise<HospitalDispatchResult> {
  if (args.message.kind !== 'interactive_reply') {
    return { consumed: Boolean(session), outcome: 'no_match' }
  }

  const id = args.message.replyId
  const db = supabaseAdmin()

  if (id === 'hospital:main') return showMainMenu(args)
  if (id === 'hospital:find_doctor') return showDepartments(args, 0, 'directory')
  if (id === 'hospital:book') return showDepartments(args, 0, 'booking')

  if (id === 'hospital:info') {
    const settings = await getSettings(db, args.accountId)
    await clearSession(db, args.conversationId)
    await sendHospitalText(
      args,
      `🏥 ${settings?.hospital_name ?? 'Bahria International Hospital Lahore'}\n\nHospital UAN: ${settings?.uan_phone ?? 'Not listed'}\n\n${settings?.appointment_note ?? 'Please confirm doctor timing with the hospital before travelling.'}`,
    )
    await engineSendInteractiveButtons({
      accountId: args.accountId,
      userId: args.userId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      bodyText: 'Return to the hospital menu?',
      buttons: [{ id: 'hospital:main', title: 'Main Menu' }],
    })
    return { consumed: true, outcome: 'hospital_info' }
  }

  if (id === 'hospital:ai') return aiHandoff(args)
  if (id === 'hospital:reception') {
    return humanHandoff(
      args,
      'A reception handoff has been requested. Please continue with the hospital reception team.',
    )
  }
  if (id === 'hospital:dept_change') {
    return showDepartments(
      args,
      0,
      session?.mode === 'booking' ? 'booking' : 'directory',
    )
  }
  if (id === 'hospital:other_doctor' && session?.department_id) {
    return showDoctors(args, session.department_id, 0, 'directory')
  }
  if (id === 'hospital:book_current' && session?.doctor_id) {
    await upsertSession(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      state: 'appointment',
      mode: 'booking',
      appointment_step: 'date',
      appointment_data: {},
    })
    await sendHospitalText(
      args,
      'What date would you prefer?\nPlease use DD/MM/YYYY.',
    )
    return { consumed: true, outcome: 'booking_started' }
  }

  let match = id.match(/^hospital:dept_(next|prev):(\d+)$/)
  if (match) {
    return showDepartments(
      args,
      numberValue(match[2]),
      session?.mode === 'booking' ? 'booking' : 'directory',
    )
  }

  match = id.match(/^hospital:dept:([0-9a-f-]{36})$/i)
  if (match) {
    return showDoctors(
      args,
      match[1],
      0,
      session?.mode === 'booking' ? 'booking' : 'directory',
    )
  }

  match = id.match(/^hospital:doctor_(next|prev):([0-9a-f-]{36}):(\d+)$/i)
  if (match) {
    return showDoctors(
      args,
      match[2],
      numberValue(match[3]),
      session?.mode === 'booking' ? 'booking' : 'directory',
    )
  }

  match = id.match(/^hospital:doctor:([0-9a-f-]{36})$/i)
  if (match) {
    return showDoctor(args, match[1])
  }

  return { consumed: Boolean(session), outcome: 'no_match' }
}

export async function dispatchInboundToHospitalDirectory(
  args: HospitalDispatchArgs,
): Promise<HospitalDispatchResult> {
  if (!ACCOUNT_ID_RE.test(args.accountId)) {
    return { consumed: false, outcome: 'no_match' }
  }

  const db = supabaseAdmin()
  const settings = await getSettings(db, args.accountId)
  if (!settings?.is_active) {
    return { consumed: false, outcome: 'no_match' }
  }

  const session = await getSession(db, args.conversationId)

  if (args.message.kind === 'interactive_reply') {
    return handleInteractive(args, session)
  }

  if (isHospitalTrigger(args.message.text) && !session) {
    return showMainMenu(args)
  }

  if (session) {
    return handleSessionText(args, session)
  }

  return { consumed: false, outcome: 'no_match' }
}

export async function retrieveHospitalAiContext(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  query: string,
): Promise<string[]> {
  const settings = await getSettings(db, accountId)
  if (!settings) return []

  const { data: departmentsData } = await db
    .from('hospital_departments')
    .select('id,name,short_name')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('sort_order')

  const departments = (departmentsData as Department[] | null) ?? []
  const normalizedQuery = normalize(query)

  const { data: doctorsData } = await db
    .from('hospital_doctors')
    .select('id,display_name,appointment_phone,location,notes,sort_order')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('sort_order')
    .limit(120)

  const doctors = (doctorsData as Doctor[] | null) ?? []
  const doctorIds = doctors.map((doctor) => doctor.id)

  const links =
    doctorIds.length > 0
      ? (
          (await db
            .from('hospital_doctor_departments')
            .select('doctor_id,department_id')
            .in('doctor_id', doctorIds)).data as DepartmentLink[] | null
        ) ?? []
      : []

  const schedules =
    doctorIds.length > 0
      ? (
          (await db
            .from('hospital_doctor_schedules')
            .select('doctor_id,days_of_week,start_time,end_time,notes')
            .in('doctor_id', doctorIds)
            .eq('is_active', true)).data as Array<
            Schedule & { doctor_id: string }
          > | null
        ) ?? []
      : []

  const departmentById = new Map(departments.map((department) => [department.id, department]))
  const schedulesByDoctor = new Map<string, Schedule[]>()

  for (const schedule of schedules) {
    const current = schedulesByDoctor.get(schedule.doctor_id) ?? []
    current.push({
      days_of_week: schedule.days_of_week,
      start_time: schedule.start_time,
      end_time: schedule.end_time,
      notes: schedule.notes,
    })
    schedulesByDoctor.set(schedule.doctor_id, current)
  }

  const matched = doctors
    .map((doctor) => {
      const departmentNames = links
        .filter((link) => link.doctor_id === doctor.id)
        .map((link) => departmentById.get(link.department_id)?.name ?? '')
        .filter(Boolean)

      const haystack = normalize(
        `${doctor.display_name} ${departmentNames.join(' ')} ${doctor.location ?? ''} ${doctor.notes ?? ''}`,
      )

      let score = 0
      if (normalizedQuery && haystack.includes(normalizedQuery)) score += 100

      for (const term of normalizedQuery.split(/[^a-z0-9]+/).filter((item) => item.length >= 3)) {
        if (haystack.includes(term)) score += 10
      }

      return { doctor, departmentNames, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.doctor.sort_order - b.doctor.sort_order)
    .slice(0, 6)

  const context = [
    `Hospital: ${settings.hospital_name}`,
    `Hospital UAN: ${settings.uan_phone ?? 'Not listed'}`,
    `Appointment note: ${settings.appointment_note ?? 'Confirm timings with the hospital.'}`,
    `Departments: ${departments.map((department) => department.name).join(', ')}`,
  ]

  if (matched.length === 0) {
    context.push(
      'No exact doctor/schedule match was found. Do not invent a doctor, timing, availability, or appointment slot. Ask for clarification or direct the patient to reception.',
    )
    return context
  }

  for (const item of matched) {
    const scheduleText = (schedulesByDoctor.get(item.doctor.id) ?? [])
      .filter((schedule) => schedule.days_of_week.length > 0)
      .map(formatSchedule)
      .join('; ')

    context.push(
      `Doctor: ${item.doctor.display_name}; Departments: ${item.departmentNames.join(', ') || 'Not listed'}; Schedules: ${scheduleText || 'Not listed'}; Appointment phone: ${item.doctor.appointment_phone ?? 'Not listed'}; Location: ${item.doctor.location ?? 'Not listed'}; Notes: ${item.doctor.notes ?? 'None'}`,
    )
  }

  context.push(
    'The structured hospital directory is the source of truth for doctor names and schedules. Never infer or invent availability.',
  )
  return context
}

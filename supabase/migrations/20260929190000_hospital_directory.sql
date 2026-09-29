-- Hospital WhatsApp directory and appointment requests.
-- Source data is seeded separately from the normalized doctor timing workbook.

CREATE TABLE IF NOT EXISTS public.hospital_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES public.accounts(id) ON DELETE CASCADE,
  hospital_name text NOT NULL,
  welcome_text text,
  uan_phone text,
  address text,
  website text,
  hours_text text,
  emergency_phone text,
  appointment_note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hospital_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  short_name text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS public.hospital_doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  source_row integer,
  display_name text NOT NULL,
  qualification text,
  appointment_phone text,
  location text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source_ref)
);

CREATE TABLE IF NOT EXISTS public.hospital_doctor_departments (
  doctor_id uuid NOT NULL REFERENCES public.hospital_doctors(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.hospital_departments(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (doctor_id, department_id)
);

CREATE TABLE IF NOT EXISTS public.hospital_doctor_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES public.hospital_doctors(id) ON DELETE CASCADE,
  source_key text NOT NULL UNIQUE,
  days_of_week smallint[] NOT NULL DEFAULT '{}',
  start_time time,
  end_time time,
  notes text,
  raw_text text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    NOT EXISTS (
      SELECT 1 FROM unnest(days_of_week) d
      WHERE d < 0 OR d > 6
    )
  )
);

CREATE TABLE IF NOT EXISTS public.hospital_directory_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL UNIQUE REFERENCES public.conversations(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('main','departments','doctors','doctor_detail','booking_department','booking_doctor','appointment')),
  department_id uuid REFERENCES public.hospital_departments(id) ON DELETE SET NULL,
  doctor_id uuid REFERENCES public.hospital_doctors(id) ON DELETE SET NULL,
  page integer NOT NULL DEFAULT 0 CHECK (page >= 0),
  mode text NOT NULL DEFAULT 'directory' CHECK (mode IN ('directory','booking')),
  appointment_step text CHECK (appointment_step IN ('date','time','name','submitted')),
  appointment_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hospital_appointment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES public.hospital_doctors(id) ON DELETE SET NULL,
  patient_name text NOT NULL,
  requested_date date,
  requested_time time,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','cancelled','rejected')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hospital_departments_account_sort_idx
  ON public.hospital_departments(account_id, sort_order);
CREATE INDEX IF NOT EXISTS hospital_doctors_account_sort_idx
  ON public.hospital_doctors(account_id, sort_order);
CREATE INDEX IF NOT EXISTS hospital_doctor_departments_department_idx
  ON public.hospital_doctor_departments(department_id, sort_order);
CREATE INDEX IF NOT EXISTS hospital_doctor_schedules_doctor_idx
  ON public.hospital_doctor_schedules(doctor_id);
CREATE INDEX IF NOT EXISTS hospital_appointment_requests_account_status_idx
  ON public.hospital_appointment_requests(account_id, status, created_at DESC);

DROP TRIGGER IF EXISTS hospital_settings_updated_at ON public.hospital_settings;
CREATE TRIGGER hospital_settings_updated_at
  BEFORE UPDATE ON public.hospital_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS hospital_departments_updated_at ON public.hospital_departments;
CREATE TRIGGER hospital_departments_updated_at
  BEFORE UPDATE ON public.hospital_departments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS hospital_doctors_updated_at ON public.hospital_doctors;
CREATE TRIGGER hospital_doctors_updated_at
  BEFORE UPDATE ON public.hospital_doctors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS hospital_directory_sessions_updated_at ON public.hospital_directory_sessions;
CREATE TRIGGER hospital_directory_sessions_updated_at
  BEFORE UPDATE ON public.hospital_directory_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS hospital_appointment_requests_updated_at ON public.hospital_appointment_requests;
CREATE TRIGGER hospital_appointment_requests_updated_at
  BEFORE UPDATE ON public.hospital_appointment_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.hospital_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_doctor_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_doctor_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_directory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_appointment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hospital_settings_select ON public.hospital_settings;
CREATE POLICY hospital_settings_select ON public.hospital_settings FOR SELECT
  TO authenticated USING (is_account_member(account_id));
DROP POLICY IF EXISTS hospital_settings_admin_write ON public.hospital_settings;
CREATE POLICY hospital_settings_admin_write ON public.hospital_settings FOR ALL
  TO authenticated USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS hospital_departments_select ON public.hospital_departments;
CREATE POLICY hospital_departments_select ON public.hospital_departments FOR SELECT
  TO authenticated USING (is_account_member(account_id));
DROP POLICY IF EXISTS hospital_departments_admin_write ON public.hospital_departments;
CREATE POLICY hospital_departments_admin_write ON public.hospital_departments FOR ALL
  TO authenticated USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS hospital_doctors_select ON public.hospital_doctors;
CREATE POLICY hospital_doctors_select ON public.hospital_doctors FOR SELECT
  TO authenticated USING (is_account_member(account_id));
DROP POLICY IF EXISTS hospital_doctors_admin_write ON public.hospital_doctors;
CREATE POLICY hospital_doctors_admin_write ON public.hospital_doctors FOR ALL
  TO authenticated USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS hospital_doctor_departments_select ON public.hospital_doctor_departments;
CREATE POLICY hospital_doctor_departments_select ON public.hospital_doctor_departments FOR SELECT
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_departments.doctor_id AND is_account_member(d.account_id)
  ));
DROP POLICY IF EXISTS hospital_doctor_departments_admin_write ON public.hospital_doctor_departments;
CREATE POLICY hospital_doctor_departments_admin_write ON public.hospital_doctor_departments FOR ALL
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_departments.doctor_id AND is_account_member(d.account_id, 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_departments.doctor_id AND is_account_member(d.account_id, 'admin')
  ));

DROP POLICY IF EXISTS hospital_doctor_schedules_select ON public.hospital_doctor_schedules;
CREATE POLICY hospital_doctor_schedules_select ON public.hospital_doctor_schedules FOR SELECT
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_schedules.doctor_id AND is_account_member(d.account_id)
  ));
DROP POLICY IF EXISTS hospital_doctor_schedules_admin_write ON public.hospital_doctor_schedules;
CREATE POLICY hospital_doctor_schedules_admin_write ON public.hospital_doctor_schedules FOR ALL
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_schedules.doctor_id AND is_account_member(d.account_id, 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hospital_doctors d
    WHERE d.id = hospital_doctor_schedules.doctor_id AND is_account_member(d.account_id, 'admin')
  ));

-- Directory sessions are private server state; only service_role should use them.
DROP POLICY IF EXISTS hospital_appointment_requests_admin_read ON public.hospital_appointment_requests;
CREATE POLICY hospital_appointment_requests_admin_read ON public.hospital_appointment_requests FOR SELECT
  TO authenticated USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS hospital_appointment_requests_admin_update ON public.hospital_appointment_requests;
CREATE POLICY hospital_appointment_requests_admin_update ON public.hospital_appointment_requests FOR UPDATE
  TO authenticated USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

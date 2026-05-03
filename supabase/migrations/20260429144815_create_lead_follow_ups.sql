/*
  # Create lead_follow_ups table

  1. New Table: `lead_follow_ups`
     - `id` (uuid, primary key)
     - `lead_id` (uuid, FK to lead_entries)
     - `reminder_date` (timestamptz) - when to follow up
     - `note` (text) - follow-up note
     - `status` (text) - PENDING or COMPLETED, default PENDING
     - `created_by` (text) - rep_code of creator
     - `created_at` (timestamptz)
     - `updated_at` (timestamptz)

  2. Security
     - RLS enabled
     - Authenticated users can insert/select/update their own follow-ups
     - Admins can access all follow-ups (via service role context)
     - Sales reps can only see follow-ups for leads assigned to them
*/

CREATE TABLE IF NOT EXISTS lead_follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES lead_entries(id) ON DELETE CASCADE,
  reminder_date timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_lead_id ON lead_follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_reminder_date ON lead_follow_ups(reminder_date);

ALTER TABLE lead_follow_ups ENABLE ROW LEVEL SECURITY;

-- Authenticated users can view follow-ups for leads they have access to
CREATE POLICY "Authenticated users can view follow-ups"
  ON lead_follow_ups FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id
        AND (
          (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
          OR le.sales_rep_code = (SELECT raw_user_meta_data->>'rep_code' FROM auth.users WHERE id = auth.uid())
        )
    )
  );

-- Authenticated users can insert follow-ups for leads they have access to
CREATE POLICY "Authenticated users can insert follow-ups"
  ON lead_follow_ups FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id
        AND (
          (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
          OR le.sales_rep_code = (SELECT raw_user_meta_data->>'rep_code' FROM auth.users WHERE id = auth.uid())
        )
    )
  );

-- Authenticated users can update follow-ups for leads they have access to
CREATE POLICY "Authenticated users can update follow-ups"
  ON lead_follow_ups FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id
        AND (
          (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
          OR le.sales_rep_code = (SELECT raw_user_meta_data->>'rep_code' FROM auth.users WHERE id = auth.uid())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id
        AND (
          (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'admin'
          OR le.sales_rep_code = (SELECT raw_user_meta_data->>'rep_code' FROM auth.users WHERE id = auth.uid())
        )
    )
  );

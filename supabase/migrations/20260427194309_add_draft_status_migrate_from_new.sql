/*
  # Add DRAFT status and migrate NEW → DRAFT

  The frontend uses DRAFT as the initial event status, but the database
  enum had NEW. This migration:
  1. Adds DRAFT to the event_status_enum
  2. Updates all events with status = 'NEW' to status = 'DRAFT'
*/

ALTER TYPE event_status_enum ADD VALUE IF NOT EXISTS 'DRAFT';

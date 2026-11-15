-- Discord reminder wording chosen by the user (fixed templates, no AI).
-- Existing users get the default 'friendly'; nothing else changes.
ALTER TABLE users ADD COLUMN reminder_tone TEXT NOT NULL DEFAULT 'friendly'
  CHECK (reminder_tone IN ('friendly', 'standard', 'formal', 'cute'));

-- "Delete my own memo" on the public board. Each browser keeps a random author key; only its
-- SHA-256 is stored with the submission. Existing rows stay NULL (nobody can claim them).
ALTER TABLE sources ADD COLUMN author_key_hash TEXT NULL;

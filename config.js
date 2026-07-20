// ---------------------------------------------------------------------
// Public Supabase project configuration.
//
// The "anon" key below is NOT a secret — Supabase is designed so this
// key is safe to ship in client-side code. Access control is enforced
// on the server by Row Level Security (RLS) policies (see
// supabase-setup.sql), not by hiding this key.
//
// The old hard-coded admin PIN has been removed from the app entirely.
// Admin write access now requires signing in with a real Supabase Auth
// account (email + password) created by you in the Supabase dashboard.
// ---------------------------------------------------------------------
window.SUPABASE_CONFIG = {
  url: 'https://zttqvrvlwgzdjsckntya.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0dHF2cnZsd2d6ZGpzY2tudHlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTgyMTEsImV4cCI6MjA5OTk3NDIxMX0.CyChPMEf-8VhrEioBzSOQO4Sg7jf30MTuYqrmZKLOGw',
};

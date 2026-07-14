/**
 * Supabase client for the frontend (browser-safe, anon/publishable key only).
 *
 * Env var handling:
 * Vite only exposes build-time env vars to client code when they're prefixed
 * `VITE_` (see vite.config.js — default envPrefix). Vercel's built-in
 * Supabase integration does NOT use that prefix; it injects generic names
 * like SUPABASE_URL / SUPABASE_ANON_KEY (and sometimes NEXT_PUBLIC_* for
 * Next.js detection), none of which Vite forwards to import.meta.env.
 *
 * To avoid a silent misconfiguration where the integration is connected but
 * the browser bundle never actually sees the values, we check several
 * possible env var names and fall back to this project's known-public
 * values (the anon key is designed to be public — safe to ship in the
 * bundle; access is enforced by Postgres RLS, see supabase/schema.sql).
 */
import { createClient } from '@supabase/supabase-js';

const FALLBACK_URL = 'https://xboxwxhoqoovliavearg.supabase.co';
const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhib3h3eGhvcW9vdmxpYXZlYXJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMTQ3OTAsImV4cCI6MjA5MTc5MDc5MH0.zrIc5FAO2xxex8TsaYUtHhg5VRB8HpDdQRYGr_3EsNs';

const env = import.meta.env ?? {};

const supabaseUrl =
  env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || FALLBACK_URL;

const supabaseAnonKey =
  env.VITE_SUPABASE_ANON_KEY ||
  env.SUPABASE_ANON_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  FALLBACK_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

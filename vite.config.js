import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Vite only auto-exposes VITE_-prefixed vars to import.meta.env. Vercel's
  // built-in Supabase integration injects generic names (SUPABASE_URL,
  // SUPABASE_ANON_KEY, sometimes NEXT_PUBLIC_SUPABASE_*) that would
  // otherwise never reach the browser bundle. loadEnv with '' as the third
  // arg loads ALL env vars (not just VITE_-prefixed), so we can forward the
  // ones we need explicitly. Only non-secret, anon/publishable values are
  // forwarded here — never the service_role key.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    build: {
      emptyOutDir: false,
    },
    define: {
      'import.meta.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL ?? ''),
      'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY ?? ''),
      'import.meta.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL ?? ''),
      'import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''),
    },
  }
})

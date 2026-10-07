// js/supabase-client.js

const SUPABASE_URL = 'https://gugmnnmjhqdtjwriaywa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Z21ubm1qaHFkdGp3cmlheXdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MzEyOTksImV4cCI6MjA5NTMwNzI5OX0.uVHpeoyla5u-LMrj4_NXX6FzYnsK2oY9rT28TH0ATjY';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: window.localStorage,
  },
});

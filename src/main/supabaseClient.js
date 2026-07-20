/**
 * supabaseClient.js — Cliente Supabase (substitui a API REST do Base44)
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://ntwfkmwprjciucydedku.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50d2ZrbXdwcmpjaXVjeWRlZGt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4Mzc2MjEsImV4cCI6MjA5ODQxMzYyMX0.Y0G4vKMeDcJ4f6Blm8jjLT_Z5IrdkWXV0L96g0BWCw4';

// Electron roda um Node embutido sem WebSocket global nativo — o cliente
// realtime do supabase-js exige um transporte explícito (não usamos
// realtime/subscriptions no PDV, só REST via .from(), mas o construtor
// inicializa o RealtimeClient de qualquer forma).
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

module.exports = supabase;

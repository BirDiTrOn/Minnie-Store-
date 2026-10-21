import { handle } from "../src/core.mjs";

// Vercel Function: answers everything under /api/ (products, login, admin, images, health).
// vercel.json sends /api/<anything> here. Settings (ADMIN_PASSWORD, SUPABASE_URL,
// SUPABASE_SERVICE_KEY) come from Vercel Environment Variables.
const run = (request) => handle(request, process.env);

export const GET = run;
export const POST = run;
export const PUT = run;

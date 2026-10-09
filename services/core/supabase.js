/*
 * Minimal Supabase client over its REST API (PostgREST), no extra package.
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (the service role key
 * bypasses RLS, so it must never leave the server).
 *
 *   select('drivers', 'id,name', { name: 'eq.Bob' })   -> rows
 *   insert('results', [ {...}, {...} ])                -> inserted rows
 *   remove('races', { id: 'eq.12' })
 */

function config() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set in .env');
    return { url: url.replace(/\/+$/, ''), key };
}

async function request(method, table, { params = {}, body, prefer } = {}) {
    const { url, key } = config();
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${url}/rest/v1/${table}${qs ? `?${qs}` : ''}`, {
        method,
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(prefer ? { Prefer: prefer } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try { detail = JSON.parse(text).message || text; } catch { /* plain text */ }
        throw new Error(`Supabase ${method} ${table}: ${res.status} ${detail}`);
    }
    return text ? JSON.parse(text) : null;
}

// filters: { column: 'eq.value', other: 'is.null', ... } (PostgREST syntax)
const select = (table, columns = '*', filters = {}) =>
    request('GET', table, { params: { select: columns, ...filters } });

const insert = (table, rows) =>
    request('POST', table, { body: rows, prefer: 'return=representation' });

const remove = (table, filters) =>
    request('DELETE', table, { params: filters });

module.exports = { select, insert, remove };

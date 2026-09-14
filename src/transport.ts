import packageInfo from "../package.json";
import { z } from 'zod';
import { AicatlogError, type Context } from './types.ts';

export type TransportCommand = { description: string; args?: z.ZodObject<any>; schema: z.ZodObject<any>; output?: z.ZodType;
  readOnly?: boolean; run: (ctx: Context, input: any) => Promise<unknown> };
function jsonSchema(schema: z.ZodType | undefined) {
  return schema ? z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, any> : {};
}
function decode(value: string | string[], schema: Record<string, any> | undefined): unknown {
  const type = schema?.type;
  if (type === 'array') return (Array.isArray(value) ? value : [value]).map(v => decode(v, schema?.items));
  if (Array.isArray(value)) return value;
  if ((type === 'integer' || type === 'number') && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (type === 'boolean' && ['true', 'false'].includes(value)) return value === 'true';
  return value;
}

export function openApi(commands: Map<string, TransportCommand>) {
  const paths: Record<string, any> = {};
  for (const [name, command] of commands) {
    const base = '/' + name.replaceAll(' ', '/');
    const schema = jsonSchema(command.schema), argsSchema = jsonSchema(command.args);
    const response = { description: 'Command result', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'data', 'meta'],
      properties: { ok: { const: true }, data: jsonSchema(command.output), meta: { type: 'object' } } } } } };
    paths[base] = { post: { operationId: name.replaceAll(' ', '_') + '_call', summary: command.description,
      requestBody: { required: true, content: { 'application/json': { schema } } }, responses: { '200': response, '400': { description: 'Invalid command input' }, '500': { description: 'Command failure' } } } };
    if (!command.readOnly) continue;
    const argNames = Object.keys(command.args?.shape ?? {});
    const required = new Set<string>(argsSchema.required ?? []);
    const min = argNames.reduce((n, key, i) => required.has(key) ? i + 1 : n, 0);
    for (let count = min; count <= argNames.length; count++) {
      const selected = argNames.slice(0, count), route = base + selected.map(key => `/{${key}}`).join('');
      const parameters = Object.entries(schema.properties ?? {}).map(([key, value]) => ({ name: key, in: selected.includes(key) ? 'path' : 'query',
        required: selected.includes(key) || (schema.required ?? []).includes(key), schema: value }));
      paths[route] ??= {};
      paths[route].get = { operationId: name.replaceAll(' ', '_') + `_get_${count}`, summary: command.description, parameters, responses: { '200': response, '400': { description: 'Invalid command input' } } };
    }
  }
  return { openapi: '3.1.0', info: { title: 'aicatlog', version: packageInfo.version }, paths };
}

export async function fetchCommand(commands: Map<string, TransportCommand>, ctx: Context, request: Request): Promise<Response> {
  const start = performance.now(); let name = '';
  try {
    const url = new URL(request.url);
    let segments: string[];
    try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new AicatlogError('INVALID_INPUT', 'Malformed URL path encoding.'); }
    if (request.method === 'GET' && ['/openapi.json', '/.well-known/openapi.json'].includes(url.pathname)) return Response.json(openApi(commands));
    name = [...commands.keys()].sort((a, b) => b.split(' ').length - a.split(' ').length)
      .find(key => key.split(' ').every((part, i) => segments[i] === part)) ?? '';
    const command = commands.get(name);
    if (!command) return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown command route.' } }, { status: 404 });
    if (request.method !== 'POST' && (request.method !== 'GET' || !command.readOnly)) return Response.json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'This operation requires POST.' } }, { status: 405 });
    const properties = jsonSchema(command.schema).properties ?? {};
    const data: Record<string, unknown> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key); data[key] = decode(values.length === 1 ? values[0]! : values, properties[key]);
    }
    const rest = segments.slice(name.split(' ').length), argNames = Object.keys(command.args?.shape ?? {});
    if (rest.length > argNames.length) throw new AicatlogError('INVALID_INPUT', 'Too many positional path values.');
    rest.forEach((value, i) => { data[argNames[i]!] = decode(value, properties[argNames[i]!]); });
    if (request.method === 'POST') {
      const text = await request.text();
      if (text) {
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new AicatlogError('INVALID_INPUT', 'Expected a JSON object.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AicatlogError('INVALID_INPUT', 'Expected a JSON object.');
        Object.assign(data, body);
      }
    }
    const result = await command.run(ctx, command.schema.parse(data));
    return Response.json({ ok: true, data: result, meta: { command: name, duration: `${Math.round(performance.now() - start)}ms` } });
  } catch (error) {
    const input = error instanceof z.ZodError || error instanceof AicatlogError && error.code === 'INVALID_INPUT';
    return Response.json({ ok: false, error: { code: input ? 'INVALID_INPUT' : error instanceof AicatlogError ? error.code : 'OPERATION_FAILED',
      message: error instanceof Error ? error.message : String(error), ...(error instanceof AicatlogError && error.details ? { details: error.details } : {}) },
      meta: { command: name, duration: `${Math.round(performance.now() - start)}ms` } }, { status: input ? 400 : error instanceof AicatlogError && error.code === 'RESOURCE_NOT_FOUND' ? 404 : 500 });
  }
}

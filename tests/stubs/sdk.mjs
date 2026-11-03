// Stand-in for the platform SDK: nothing here talks to the network.
export const api = new Proxy({}, { get: () => async () => { throw new Error('api not available in tests'); } });
export const fetch = Object.assign(async () => { throw new Error('fetch not available in tests'); }, {
  body: { json: (x) => JSON.stringify(x), form: (x) => new URLSearchParams(x).toString(), text: (x) => x },
});
export class FormData { constructor() { this.fields = []; } append(k, v) { this.fields.push([k, v]); } }
export class InputFile { constructor(bytes, name, opts) { this.bytes = bytes; this.name = name; this.type = opts && opts.type; } }
export class BotApiError extends Error {}
export class EndpointError extends Error {}
const settings = new Map();
export const db = {
  async get() { return null; },
  async all() { return []; },
  async run() { return { rowsAffected: 0, rows: [] }; },
  settings,
};

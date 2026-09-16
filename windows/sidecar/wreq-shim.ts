import { createRequire } from "node:module";
import type * as Wreq from "wreq-js";

const load = createRequire(import.meta.url);
const wreq = load("./vendor/wreq-js/dist/wreq-js.cjs") as typeof Wreq;

export const createTransport = wreq.createTransport;
export const fetch = wreq.fetch;
export type Transport = Wreq.Transport;

import type { Env as GuruTimeEnv } from "../src/types";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends GuruTimeEnv {}
}

// Every test runs with its own empty home folder, so nothing can read or write the real ~/.config/dd2dash0/.env
// (or any other per-user file) on the developer's machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dd2dash0-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_CACHE_HOME = join(home, ".cache");
delete process.env.APPDATA;

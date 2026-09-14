import { pathToFileURL } from "node:url";
import type { AdminCliErrorBody } from "@ilearnassist/shared";
import { adminStatus, createAdmin, resetAdmin, type AdminCliOutcome } from "./adminCli.js";
import { resolveDataRoot } from "./config.js";
import { apiError } from "./apiError.js";

/**
 * The administrator CLI: argv, stdin, and exit codes. Nothing else.
 *
 * Every rule it applies lives in `adminCli.ts`, which takes its inputs as arguments and returns
 * a value. This file is the part that cannot be tested without spawning a process — which is
 * why it is kept to the smallest thing that can be: read the flags, call the rule, print the
 * envelope, set the exit code.
 *
 * **Two callers, two reporters.** A person at a terminal gets sentences; the control panel
 * passes `--json` and gets the envelope. Both come from the same result, so the panel's
 * catalog and the terminal's wording cannot describe different outcomes.
 *
 * There is deliberately **no hidden password prompt**. Suppressing echo means `setRawMode` and
 * hand-rolled editing, which leaks on Ctrl-C and mishandles paste, and cannot be asserted from
 * a test. `--password-stdin` is one line to EOF; `--generate` invents one and prints it once.
 * Asking for neither is a usage error that names both.
 *
 * Usage:
 *   cli status [--json]
 *   cli create-admin --username <name> (--password-stdin | --generate) [--json]
 *   cli ensure-admin --username <name> (--password-stdin | --generate) [--json]
 *   cli reset-admin [--username <name>] (--password-stdin | --generate) [--json]
 */

/** ok / coded refusal / usage. `1` alone proves nothing — an uncaught throw exits 1 too. */
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

interface Args {
  command: string;
  json: boolean;
  username?: string;
  generate: boolean;
  passwordStdin: boolean;
}

function parseArgs(argv: string[]): { args: Args } | { usage: AdminCliErrorBody } {
  const [command, ...rest] = argv;
  const args: Args = { command: command ?? "", json: false, generate: false, passwordStdin: false };

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--generate":
        args.generate = true;
        break;
      case "--password-stdin":
        args.passwordStdin = true;
        break;
      case "--username":
        args.username = rest[i + 1];
        i += 1;
        if (args.username === undefined) {
          return { usage: apiError("USAGE", "--username needs a value") };
        }
        break;
      default:
        return { usage: apiError("USAGE", `unknown argument: ${flag}`, { flag: flag ?? "" }) };
    }
  }
  return { args };
}

/** One line from stdin. Nothing to read is not a password. */
async function readPasswordLine(): Promise<string | undefined> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  // The trailing newline a shell adds is not part of the password, and neither is a `\r` from a
  // pipe on Windows. Everything else is kept verbatim — trimming whitespace out of a password
  // would silently change it.
  const line = raw.split("\n")[0] ?? "";
  return line.replace(/\r$/, "");
}

async function run(args: Args): Promise<AdminCliOutcome | { usage: AdminCliErrorBody }> {
  let dataRoot: string;
  try {
    dataRoot = resolveDataRoot();
  } catch (error) {
    // `resolveDataRoot` already writes the sentence, and it is a good one — it names the
    // variable and both ways to set it. Mapped to a code rather than re-worded, so the panel
    // has something to key a translation on.
    return {
      usage: apiError("DATA_DIR_MISSING", error instanceof Error ? error.message : String(error)),
    };
  }

  switch (args.command) {
    case "status":
      return adminStatus(dataRoot);

    case "create-admin":
    case "ensure-admin": {
      const username = args.username?.trim();
      if (!username) return { usage: apiError("USAGE", "--username is required") };
      if (args.generate === args.passwordStdin) {
        return {
          usage: apiError("USAGE", "pass exactly one of --password-stdin or --generate"),
        };
      }

      const password = args.passwordStdin ? await readPasswordLine() : undefined;
      if (args.passwordStdin && password === undefined) {
        return { usage: apiError("USAGE", "--password-stdin got nothing on stdin") };
      }

      return createAdmin({
        dataRoot,
        username,
        password,
        ensureOnly: args.command === "ensure-admin",
      });
    }

    /*
     * The way back in for a forgotten password, and the only command here that acts on an
     * installation somebody already administers. `--username` is optional: the panel does not
     * know any names, and "the first enabled superadmin" is the account it means.
     *
     * Like create-admin it gets the password one of two ways: the panel hands over the
     * operator's own choice on stdin, a terminal asks for `--generate`. Exactly one is
     * required, for the same reason it is there: neither an empty stdin nor an invented
     * password the caller did not ask for is a result anyone wants.
     *
     * It refuses when the named account is not a superadmin rather than resetting it anyway —
     * see `resetAdmin`. The recovery path is for the credential that can undo the installation;
     * an ordinary account's password is the web console's business.
     */
    case "reset-admin": {
      if (args.generate === args.passwordStdin) {
        return { usage: apiError("USAGE", "pass exactly one of --password-stdin or --generate") };
      }
      const password = args.passwordStdin ? await readPasswordLine() : undefined;
      if (args.passwordStdin && password === undefined) {
        return { usage: apiError("USAGE", "--password-stdin got nothing on stdin") };
      }
      return resetAdmin({
        dataRoot,
        username: args.username?.trim() || undefined,
        password,
      });
    }

    default:
      return {
        usage: apiError("USAGE", `unknown command: ${args.command || "(none)"}`, {
          command: args.command,
        }),
      };
  }
}

/** The terminal's rendering of the same result the panel reads as JSON. */
function report(outcome: AdminCliOutcome): void {
  if (!outcome.ok) {
    process.stderr.write(`${outcome.body.error.message}\n`);
    return;
  }

  const value = outcome.value;
  if (value.command === "status") {
    if (value.database === "absent") {
      process.stdout.write(`No database in ${value.dataRoot} — this installation is not set up.\n`);
      return;
    }
    process.stdout.write(
      value.hasAdmin
        ? `Administrator: ${value.adminUsername}\n`
        : `No administrator in ${value.dataRoot}. Create one with: cli create-admin --username <name>\n`
    );
    return;
  }

  if (value.command === "reset-admin") {
    process.stdout.write(
      `Reset the password for "${value.username}" and signed it out everywhere.\n`
    );
    // A chosen password is not echoed back — the caller already has it. Only the generated one
    // is shown, once, because it exists nowhere but this line.
    if (value.password) {
      process.stdout.write(
        `\nPassword (shown once — only a hash is stored): ${value.password}\n\n` +
          `Sign in with it and change it from your account page.\n`
      );
    }
    return;
  }

  if (!value.created) {
    process.stdout.write(`Already administered by "${value.username}" — nothing to do.\n`);
    return;
  }
  process.stdout.write(
    `${value.adopted ? "Adopted" : "Created"} administrator "${value.username}".\n`
  );
  if (value.password) {
    process.stdout.write(
      `\nPassword (shown once — only a hash is stored): ${value.password}\n\n` +
        `Sign in with it and change it from your account page.\n`
    );
  }
}

const USAGE = `Usage:
  cli status [--json]
  cli create-admin --username <name> (--password-stdin | --generate) [--json]
  cli ensure-admin --username <name> (--password-stdin | --generate) [--json]
  cli reset-admin [--username <name>] (--password-stdin | --generate) [--json]
`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  // `--json` is honoured even when the arguments are wrong, so a caller that always passes it
  // always gets an envelope back rather than sometimes a sentence.
  const json = "args" in parsed ? parsed.args.json : false;

  if ("usage" in parsed) {
    if (json) process.stderr.write(`${JSON.stringify(parsed.usage)}\n`);
    else {
      process.stderr.write(`${parsed.usage.error.message}\n\n${USAGE}`);
    }
    return EXIT_USAGE;
  }

  const outcome = await run(parsed.args);
  if ("usage" in outcome) {
    if (json) process.stderr.write(`${JSON.stringify(outcome.usage)}\n`);
    else process.stderr.write(`${outcome.usage.error.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (json) {
    // Success on stdout, failure on stderr, so a caller can pipe one and still see the other.
    const stream = outcome.ok ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(outcome.ok ? outcome.value : outcome.body)}\n`);
  } else {
    report(outcome);
  }
  return outcome.ok ? EXIT_OK : EXIT_REFUSED;
}

// Runs only when this file *is* the program — the same guard the fake LLM and parser use, so
// the module can also be imported (its rules live next door, but a future caller may want this
// file's `run` without starting a process).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(EXIT_REFUSED);
    });
}

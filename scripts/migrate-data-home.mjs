import { migrateDataHome } from "../dist/data-migration.js";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error(JSON.stringify({ code: "USAGE", arguments: ["source-data-directory", "new-data-directory"] }));
  process.exitCode = 1;
} else {
  try {
    const result = await migrateDataHome(source, destination, phase => console.log(JSON.stringify({ phase })));
    console.log(JSON.stringify({ complete: true, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ complete: false, code: error.code ?? "MIGRATION_FAILED" }));
    process.exitCode = 1;
  }
}

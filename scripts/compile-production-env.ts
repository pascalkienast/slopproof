import {
  loadGithubControlConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "@slopproof/config";
import {
  assertSafeProductionOutputDirectory,
  compileProductionEnvironment,
  installProductionKeyFiles,
  partitionProductionEnvironment,
  ProductionEnvironmentError,
  renderProductionEnvironment,
  writeProductionEnvironmentFile,
} from "./lib/production-environment";

const argumentsWithoutSeparator = process.argv
  .slice(2)
  .filter((argument) => argument !== "--");
const outputDirectory = argumentsWithoutSeparator[0];

if (!outputDirectory) {
  console.error(
    "Usage: pnpm production:env -- /absolute/empty-output-directory",
  );
  process.exitCode = 2;
} else {
  try {
    assertSafeProductionOutputDirectory(outputDirectory, process.cwd());
    const compiled = compileProductionEnvironment(process.env);
    const partitions = partitionProductionEnvironment(compiled);
    loadWebConfig(partitions.web);
    loadWorkerConfig(partitions.worker);
    loadGithubControlConfig(partitions.githubControl);
    installProductionKeyFiles(process.env, outputDirectory);
    const files = [
      ["web.env", partitions.web],
      ["worker.env", partitions.worker],
      ["github-control.env", partitions.githubControl],
      ["migrate.env", partitions.migrate],
    ] as const;
    for (const [fileName, environment] of files) {
      writeProductionEnvironmentFile(
        `${outputDirectory}/${fileName}`,
        renderProductionEnvironment(environment),
      );
    }
    console.log(
      `Installed ${String(files.length)} process-scoped environment files and 3 key files.`,
    );
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      console.error("Production environment installation failed.");
      process.exitCode = 1;
    }
  }
}

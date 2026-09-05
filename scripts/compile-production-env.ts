import {
  loadGithubControlConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "@understandproof/config";
import {
  assertSafeProductionOutputDirectory,
  compileProductionEnvironment,
  installProductionArtifacts,
  partitionProductionEnvironment,
  ProductionEnvironmentError,
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
    installProductionArtifacts(process.env, outputDirectory, partitions);
    console.log(
      "Installed 5 process-scoped environment files, 3 key files, and a database password file.",
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

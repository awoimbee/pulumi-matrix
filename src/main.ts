import { createNamespace } from "./utils.js";
import globals from "./globals.js";
import deployApps from "./apps/mod.js";
import deployCriticalApps from "./extensions/mod.js";
import deployIngress from "./ingress/mod.js";
import deployRbacConfig from "./rbac.js";

async function main () {
  await deployCriticalApps();

  const coreProductNamespace = createNamespace("core-product");
  const apps = await deployApps();
  const monitoringNamespace = apps.monitoring.namespaceName;
  const TLSCertSecretRef = apps.certManager.certificateSecretRef;
  const ingresses = await deployIngress(monitoringNamespace, TLSCertSecretRef);
  await deployRbacConfig(coreProductNamespace, apps.namespaceName);

  const aws = await globals.refFoundationsStack.getOutputValue("aws");

  /**
   * The returns here are a public API, other stacks WILL reference the base stack.
   */
  return {
    auth: {
      grafanaClientSecret: globals.cfg.requireSecret("grafanaClientSecret"),
      keycloakAdminPassword: apps.keycloak.adminPassword,
      keycloakAdminUrl: apps.keycloak?.adminUrl,
      keycloakUrl: apps.keycloak?.url
    },
    priorityClasses: globals.refFoundationsStack.requireOutput("priorityClassNames"),
    masterDomain: globals.refFoundationsStack.requireOutput("masterDomain"),
    env: globals.env,
    platform: globals.platform,
    ingressClassNames: ingresses.ingressClassNames,
    rabbitmq: apps.rabbitmq,
    redis: apps.redis,
    tempo: apps.monitoring.tempo,
    clearml: apps.clearml,

    // AWS stuff
    eks: aws?.eks,
    serviceRoles: aws?.serviceRoles,
    region: aws?.region,
    s3: aws?.s3,

    // on-prem stuff
    minio: apps.minio,

    // deprecated stuff here for backwards compatibility
    registry: {
      proxies: ["docker", "quay", "nvcr", "ecr", "ghcr"],
      uri: "127.0.0.1:31757"
    }
  };
}

export default main;

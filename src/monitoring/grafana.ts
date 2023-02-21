import * as k8s from "@pulumi/kubernetes";
import { Input, interpolate } from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { promises as fs } from "fs";

import globals, { provider } from "../../globals.js";
import { HelmChart } from "../../utils.js";

export default async function deploy (
  namespace: Input<string>,
  keycloakUri: Input<string>
) {
  const masterDomain: string = await globals.refFoundationsStack.requireOutputValue("masterDomain");
  const keycloakOidcUri = interpolate`${keycloakUri}/auth/realms/extrality/protocol/openid-connect`;
  const grafanaClientSecret = globals.cfg.requireSecret("grafanaClientSecret");
  const rootUrl = `https://logs.${masterDomain}`;
  const tlsSkipVerifyInsecure = await globals.refFoundationsStack.getOutputValue("tlsSkipVerifyInsecure") === "true";

  const grafanaAdminPassword = new RandomPassword("grafana-admin-password", {
    length: 20,
    special: true
  });

  /* https://github.com/grafana/helm-charts/tree/main/charts/grafana */
  const grafana = new HelmChart("grafana", {
    chart: "grafana",
    version: "6.48",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts"
    },
    namespace,
    values: {
      adminPassword: grafanaAdminPassword.result,
      ingress: {
        enabled: true,
        ingressClassName: "nginx-internal",
        hosts: [`logs.${masterDomain}`]
      },
      sidecar: {
        dashboards: { enabled: true },
        datasources: { enabled: true },
        notifiers: { enabled: true }
      },
      "grafana.ini": {
        server: {
          root_url: rootUrl
        },
        users: {
          auto_assign_org_role: "Editor"
        },
        "auth.generic_oauth": {
          enabled: true,
          name: "Oauth",
          allow_sign_up: true,
          scopes: "openid profile email",
          client_id: "grafana",
          client_secret: grafanaClientSecret,
          auth_url: interpolate`${keycloakOidcUri}/auth`,
          token_url: interpolate`${keycloakOidcUri}/token`,
          api_url: interpolate`${keycloakOidcUri}/userinfo`,
          signout_redirect_url: interpolate`${keycloakOidcUri}/logout?redirect_uri=${rootUrl}`,
          tls_skip_verify_insecure: tlsSkipVerifyInsecure
        },
        smtp: {
          enabled: true,
          from_address: "grafana@internal.extrality.ai",
          host: "email-smtp.eu-west-1.amazonaws.com:465",
          user: globals.cfg.requireSecret("smtpGrafanaUsername"),
          password: globals.cfg.requireSecret("smtpGrafanaPassword"),
          startTLS_policy: "NoStartTLS",
          skip_verify: false
        }
      }
    }
  }, { provider });

  const grafanaDashboards = new k8s.core.v1.ConfigMap(
    "grafana-custom-dashboards",
    {
      metadata: {
        name: "grafana-custom-dashboards",
        namespace,
        labels: {
          grafana_dashboard: "1"
        }
      },
      data: readGrafanaDashboards()
    },
    { provider }
  );

  return {
    grafana,
    grafanaDashboards
  };
}

/**
 * Reads grafana dashboard json definitions and return them in
 * a configmap friendly format
 */
async function readGrafanaDashboards () {
  const dashboards: Record<string, Promise<string>> = {};
  const filePrefix = "dashboard_";
  const readdir = await fs.readdir("./conf/grafana/");
  for (const filename of readdir) {
    if (!filename.startsWith(filePrefix) || !filename.endsWith(".json")) {
      continue;
    }
    const dashboardName = filename.slice(filePrefix.length);
    const dashboardContents = fs.readFile(
      `./conf/grafana/${filename}`,
      "utf8"
    );

    dashboards[dashboardName] = dashboardContents;
  }

  return dashboards;
}

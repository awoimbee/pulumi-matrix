import { Input } from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { strict as assert } from "assert";

import globals, { provider } from "../../globals.js";
import { HelmChart } from "../../utils.js";

function alertmanagerConfig () {
  // AlertManager is very picky and requires some random config values
  // ALWAYS double check /status

  const defaultReceiver = {
    name: "default",
    slack_configs: <any[]>[],
    email_configs: <any[]>[]
  };

  const slackWebhook = globals.cfg.getSecret("alertmanagerSlackWebhook");
  if (slackWebhook !== undefined) {
    defaultReceiver.slack_configs.push({
      api_url: slackWebhook,
      channel: `alertmanager-${globals.env}`
    });
  }

  // route matching alerts to the "null" receiver
  // https://prometheus.io/docs/alerting/latest/configuration/#matcher
  const inTheBin = (...matchers: string[]) => ({ matchers, receiver: "null" });

  const routing = {
    group_by: ["cluster"],
    group_wait: "30s",
    group_interval: "5m",
    repeat_interval: "12h",
    // default receiver
    receiver: "default",
    routes: [
      // false alarm (https://youtu.be/CW5oGRx9CLM)
      inTheBin("alertname = Watchdog"),
      // By normal standards we should have sufficient CPU & Memory capacity to rollout-restart any pod
      // we do not desire this behavior for batch jobs. There is no way to configure this. In The Bin !
      inTheBin("alertname = KubeCPUOvercommit"),
      inTheBin("alertname = KubeMemoryOvercommit"),
      // https://runbooks.prometheus-operator.dev/runbooks/general/infoinhibitor/
      // https://github.com/prometheus-community/helm-charts/issues/1773
      inTheBin("alertname = InfoInhibitor")
    ]
  };

  let smtpConfig: any = {};
  const smtpUsername = globals.cfg.getSecret("smtpAlertmanagerUsername");
  const smtpPassword = globals.cfg.getSecret("smtpAlertmanagerPassword");
  // eslint-disable-next-line eqeqeq
  assert((smtpUsername == undefined) == (smtpPassword == undefined));

  if (smtpUsername != undefined) { // eslint-disable-line eqeqeq
    smtpConfig = {
      smtp_from: `AlertManager-${globals.platform}-${globals.env} <alertmanager@internal.extrality.ai>`,
      smtp_smarthost: "email-smtp.eu-west-1.amazonaws.com:587",
      smtp_auth_username: smtpUsername,
      smtp_auth_password: smtpPassword,
      smtp_require_tls: true
    };
    defaultReceiver.email_configs.push(
      { to: "engineering@extrality.ai" }
    );
  }

  return {
    enabled: true,
    config: {
      global: {
        ...smtpConfig
      },
      receivers: [
        defaultReceiver,
        { name: "null" }
      ],
      route: routing
    }
  };
}

export default async function deploy (
  namespace: Input<string>
) {
  /* https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack */
  const prometheusStack = new HelmChart("prometheus-stack", {
    chart: "kube-prometheus-stack",
    version: "43.0",
    fetchOpts: {
      repo: "https://prometheus-community.github.io/helm-charts"
    },
    namespace,
    values: {
      alertmanager: alertmanagerConfig(),
      grafana: {
        // grafana isn't deployed, but datasources and dashboards are
        enabled: false,
        forceDeployDatasources: true,
        forceDeployDashboards: true
      },
      // Optimized for EKS:
      kubeScheduler: {
        enabled: false
      },
      kubeEtcd: {
        enabled: false
      },
      kubeControllerManager: {
        enabled: false
      },
      prometheus: {
        prometheusSpec: {
          podMonitorSelectorNilUsesHelmValues: false,
          serviceMonitorSelectorNilUsesHelmValues: false,
          ruleSelectorNilUsesHelmValues: false,
          storageSpec: {
            volumeClaimTemplate: <k8s.types.input.core.v1.PersistentVolumeClaim>{
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "20Gi"
                  }
                }
              },
              selector: {}
            }
          }
        }
      }
    },
    transformations: [
      (obj: any) => {
        if (obj.kind === "CustomResourceDefinition") {
          // delete object
          obj.apiVersion = "v1";
          obj.kind = "List";
          obj.items = [];
        }
      }
    ]
  }, { provider });

  const alertmanagerSvc = prometheusStack.getResourceProperty(
    "v1/Service",
    "monitoring/prometheus-stack-kube-prom-alertmanager",
    "metadata"
  ).apply(m => m.name);

  /** Service monitor for extrality apps: */
  const metricsServiceRequirements = {
    label: "prometheus-metrics",
    port: "metrics"
  };

  const prometheusServiceScraping = new k8s.apiextensions.CustomResource(
    "extrality-services-scraping",
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: {
        name: "extrality-services-scraping",
        labels: {
          release: "prometheus-stack"
        },
        namespace
      },
      spec: {
        selector: {
          matchExpressions: [{
            key: metricsServiceRequirements.label, operator: "Exists"
          }]
        },
        namespaceSelector: {
          any: true
        },
        endpoints: [{ port: metricsServiceRequirements.port, interval: "15s" }]
      }
    },
    {
      dependsOn: [prometheusStack],
      provider
    }
  );

  return {
    alertmanagerSvc,
    metricsServiceRequirements,
    prometheusServiceScraping,
    ready: prometheusStack.ready
  };
}

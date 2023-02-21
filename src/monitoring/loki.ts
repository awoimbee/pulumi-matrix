import { Input } from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as yaml from "js-yaml";

import globals, { provider } from "../../globals.js";
import { HelmChart } from "../../utils.js";

export default async function deploy (
  namespace: Input<string>,
  alertmanagerSvc: Input<string>
) {
  const lokiChart = new HelmChart("loki", {
    chart: "loki",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts"
    },
    version: "4.6",
    // https://github.com/grafana/loki/tree/main/production/helm/loki
    values: {
      loki: {
        auth_enabled: false,
        commonConfig: {
          replication_factor: 1
        },
        storage: {
          type: "filesystem"
        },
        limits_config: {
          max_query_length: "0h",
          ingestion_rate_strategy: "local"
        },
        structuredConfig: {
          table_manager: {
            retention_deletes_enabled: true,
            retention_period: "1464h" // 61 days
          }
        }
      },
      gateway: {
        enabled: false
      },
      singleBinary: {
        replicas: 1,
        persistence: {
          size: "20Gi"
        },
        resources: {
          limits: {
            memory: "350Mi"
          },
          requests: {
            cpu: "100m",
            memory: "200Mi"
          }
        },
        // https://github.com/grafana/loki/issues/7914
        // Fixes loki issue due to some of our envs (preprod) not using stadard private IP space
        extraEnv: [{
          name: "MY_POD_IP",
          valueFrom: {
            fieldRef: { fieldPath: "status.podIP" }
          }
        }],
        extraArgs: ["-memberlist.bind-addr=$(MY_POD_IP)"]
      },
      monitoring: {
        selfMonitoring: {
          enabled: false, // requires grafana agent
          grafanaAgent: {
            // Grafana agent was designed for grafana cloud, we don't want that
            installOperator: false
          }
        },
        lokiCanary: {
          enabled: false // not useful without alerting rules/grafana dashboards
        }
      },
      test: {
        enabled: false // requires selfMonitoring
      }
    },
    namespace
  }, { provider });

  const lokiSvcMeta = lokiChart.getResourceProperty("v1/Service", "monitoring/loki", "metadata");
  const lokiAddress = lokiSvcMeta.apply(m => `http://${m.name}.${m.namespace}:3100/loki/api/v1/push`);

  let promtailDockershimSpecificSnippets;
  if (globals.cfg.getBoolean("usesDockershim") === true) {
    console.warn("Dockershim is deprecated, please upgrade !");
    // Currently our bare-metal offering uses dockershim (bad), eks uses cri (good)
    // This affects how logs are pushed to Loki.
    promtailDockershimSpecificSnippets = {
      pipelineStages: [{ docker: {} }]
    };
  }

  new HelmChart("promtail", {
    chart: "promtail",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts"
    },
    version: "6.7",
    // https://github.com/grafana/helm-charts/blob/main/charts/promtail/values.yaml
    values: {
      config: {
        clients: [{ url: lokiAddress }],
        snippets: promtailDockershimSpecificSnippets
      },
      podAnnotations: {
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "true"
      },
      tolerations: [{
        effect: "NoSchedule",
        operator: "Exists"
      }],
      serviceMonitor: {
        enabled: true,
        namespace
      }
    },
    namespace
  }, { provider });

  new k8s.core.v1.ConfigMap("grafana-loki-datasource", {
    metadata: {
      namespace,
      labels: {
        grafana_datasource: "1"
      }
    },
    data: {
      "loki-datasource.yaml": yaml.dump({
        apiVersion: 1,
        datasources: [{
          name: "Loki",
          type: "loki",
          uid: "loki",
          access: "proxy",
          url: "http://loki.monitoring:3100",
          version: 1,
          jsonData: {
            derivedFields: [
              {
                // Parse trace ids (JSON format) and link them to Tempo
                datasourceUid: "tempo",
                matcherRegex: "[tT]race[iI][dD]\":\\s\"([a-zA-Z0-9]+)\"",
                name: "traceId",
                url: "$${__value.raw}" // eslint-disable-line no-template-curly-in-string
              }
            ]
          }
        }]
      })
    }
  }, { provider });

  return {};
}

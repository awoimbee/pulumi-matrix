import * as k8s from "@pulumi/kubernetes";
import { deepmerge } from "deepmerge-ts";
import { Input, output } from "@pulumi/pulumi";
import { promises as fs } from "fs";
import fetch from "node-fetch";
import outdent from "outdent";
import assert from "node:assert/strict";

import { HelmChart, createNamespace } from "../utils.js";
import globals, { provider } from "../globals.js";

export default async function manager (
  namespaceMonitoring: Input<string>,
  TLSCertSecretRef: Input<string> | undefined
) {
  if (TLSCertSecretRef === undefined) {
    let key, cert;
    try {
      key = await fs.readFile("./conf/certs/tls.key", "utf8");
      cert = await fs.readFile("./conf/certs/tls.crt", "utf8");
    } catch {
      throw Error("nginx: No TLS cert given and no ./conf/certs/tls.* found");
    }
    const secret = new k8s.core.v1.Secret("nginx-tls-cert", {
      type: "kubernetes.io/tls",
      metadata: { namespace: "default" },
      stringData: { "tls.key": key, "tls.crt": cert }
    });
    TLSCertSecretRef = secret.metadata.apply(m => `${m.namespace}/${m.name}`);
  }

  await createGrafanaDashboards(
    namespaceMonitoring,
    "helm-chart-4.1.0"
  );
  const deployPublicIngress = globals.cfg.getBoolean("publicIngress") === true;
  let ingressClassPublic: Input<k8s.networking.v1.IngressClass> | null = null;
  let ingressClassInternal: Input<k8s.networking.v1.IngressClass> | null = null;

  if (deployPublicIngress) {
    assert.equal(globals.platform, "aws", "public ingress only supported on aws");

    const pubIngress = await deployIngressNginx({
      namespaceMonitoring,
      TLSCertSecretRef,
      isPublic: true
    });
    const privIngress = await deployIngressNginx({
      namespaceMonitoring,
      TLSCertSecretRef,
      isPublic: false
    });
    ingressClassInternal = privIngress.ingressClass;
    ingressClassPublic = pubIngress.ingressClass;
  } else {
    const privIngress = await deployIngressNginx({
      namespaceMonitoring,
      TLSCertSecretRef,
      isPublic: false
    });
    ingressClassInternal = privIngress.ingressClass;

    // Create fake public ingressClass that points to internal ingress
    // Thus deployments don't need to know about the nginx setup
    ingressClassPublic = new k8s.networking.v1.IngressClass(
      "nginx-public",
      {
        metadata: {
          name: "nginx-public",
          namespace: "default"
        },
        spec: {
          controller: "extrality.ai/nginx-internal"
        }
      }, {
        provider,
        dependsOn: [ingressClassInternal],
        replaceOnChanges: ["*"],
        deleteBeforeReplace: true
      }
    );
  }

  // Temporary compatibility with older deployments
  new k8s.networking.v1.IngressClass("nginx-compat", {
    metadata: {
      name: "nginx",
      namespace: "default"
    },
    spec: {
      controller: output(ingressClassPublic).apply(ic => ic.spec.controller)
    }
  }, { provider, dependsOn: [ingressClassPublic], replaceOnChanges: ["*"], deleteBeforeReplace: true });

  return {
    ingressClassInternal,
    ingressClassPublic
  };
}

interface deployIngressNginxArgs {
  namespaceMonitoring: Input<string>,
  TLSCertSecretRef: Input<string>,
  isPublic: boolean,
}

async function deployIngressNginx (args: deployIngressNginxArgs) {
  let customDeploymentValues;
  const cfgIngressClassName = args.isPublic ? "nginx-public" : "nginx-internal";
  const namespaceName = createNamespace(`ingress-${cfgIngressClassName}`);

  if (globals.platform === "aws") {
    const scheme = args.isPublic ? "internet-facing" : "internal";

    customDeploymentValues = {
      controller: {
        service: {
          type: "LoadBalancer",
          annotations: <Record<string, string>>{
            "service.beta.kubernetes.io/aws-load-balancer-type": "external",
            "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
            "service.beta.kubernetes.io/aws-load-balancer-ip-address-type": "dualstack",
            "service.beta.kubernetes.io/aws-load-balancer-proxy-protocol": "*",
            "service.beta.kubernetes.io/aws-load-balancer-name": `ingress-${cfgIngressClassName}`,
            "service.beta.kubernetes.io/aws-load-balancer-scheme": scheme
          }
        },
        config: {
          "use-proxy-protocol": "true"
        },
        ingressClassResource: {}
      }
    };
  } else {
    assert(!args.isPublic, "We don't handle public bare-metal ingress yet");
    customDeploymentValues = {
      controller: {
        hostPort: { enabled: true },
        service: { type: "ClusterIP" }
      }
    };
  }

  customDeploymentValues.controller.ingressClassResource = {
    name: cfgIngressClassName,
    controllerValue: `extrality.ai/${cfgIngressClassName}`
  };

  /**
   * https://github.com/kubernetes/ingress-nginx/tree/master/charts/ingress-nginx
   * Notes:
   * - Check TLS security via `docker run --rm -it drwetter/testssl.sh https://api.xxx.extrality.ai`
   */
  const chart = new HelmChart(`ingress-${cfgIngressClassName}`, {
    chart: "ingress-nginx",
    namespace: namespaceName,
    version: "4.4",
    fetchOpts: {
      repo: "https://kubernetes.github.io/ingress-nginx"
    },
    apiVersions: ["monitoring.coreos.com/v1"],
    values: deepmerge(
      customDeploymentValues,
      {
        controller: {
          ingressClass: null,
          kind: "DaemonSet",
          metrics: {
            enabled: true,
            serviceMonitor: {
              namespaceSelector: { matchNames: [namespaceName] },
              enabled: true,
              namespace: args.namespaceMonitoring
            }
          },
          /* https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/ */
          config: {
            hsts: "true",
            // Set requests, connections and streams limits for HTTP 1 and 2
            "http-snippet": outdent`
              # Global rate limiting zones per client IP address
              # Note that current limits are extremely large.
              limit_req_zone $binary_remote_addr zone=global_req_ip:10m rate=250r/s;
              limit_conn_zone $binary_remote_addr zone=global_con_ip:10m;
            `,
            "location-snippet": outdent`
              limit_req zone=global_req_ip burst=1000 nodelay;
              limit_conn global_con_ip 800;
            `,
            "http2-max-concurrent-streams": "1000",
            keepalive_requests: "1000000",
            "ignore-invalid-headers": "false",

            // Temp fix for Chrome bug w/ many concurrent requests.
            "use-http2": "false",

            "ssl-redirect": "true",
            "force-ssl-redirect": "true",
            "server-tokens": "false",

            // Don't enable OWASP, it's really bad
            "enable-modsecurity": "true",
            "modsecurity-snippet": await fs.readFile("./conf/nginx/modsecurity_override.conf", { encoding: "utf8" }),

            // This blacklist is a CVE fix, but it's problematic (TODO: check how this evolves)
            "annotation-value-word-blocklist": "load_module,lua_package,_by_lua,location,root,proxy_pass,serviceaccount,\\",

            // https://github.com/kubernetes/ingress-nginx/issues/6141#issuecomment-1116664886
            "worker-processes": "6"
          },
          extraArgs: {
            "default-ssl-certificate": args.TLSCertSecretRef
          }
        }
      }
    )
  }, { provider });

  const ingressClass = chart.getResource("networking.k8s.io/v1/IngressClass", cfgIngressClassName);
  const ingressClassName = ingressClass.apply(ic => ic.metadata.apply(m => m.name));

  return {
    ingressClassName,
    ingressClass
  };
}

async function createGrafanaDashboards (
  namespaceName: Input<string>,
  gitRef: string
) {
  const fetchFileUrl = `https://raw.githubusercontent.com/kubernetes/ingress-nginx/${gitRef}/deploy/grafana/dashboards/`;
  const listFilesUrl = `https://api.github.com/repos/kubernetes/ingress-nginx/contents/deploy/grafana/dashboards?ref=${gitRef}`;
  const dashboardNames = await fetch(listFilesUrl).then(async res => {
    const dir = <any[]> await res.json();
    return dir
      .map(file => file.name as string)
      // ignore non json and hidden files
      .filter(name => name.endsWith(".json") && !name.startsWith("."));
  });
  const dashboards = dashboardNames.map(name => {
    const dashboard = fetch(fetchFileUrl + name).then(res => res.text());
    return { [name]: dashboard };
  }).reduce((acc, x) => ({ ...acc, ...x }));

  const grafanaNginxDashboards = new k8s.core.v1.ConfigMap(
    "grafana-nginx-dashboards",
    {
      metadata: {
        name: "grafana-nginx-dashboards",
        namespace: namespaceName,
        labels: {
          grafana_dashboard: "1"
        }
      },
      data: dashboards
    },
    { provider }
  );

  return grafanaNginxDashboards;
}

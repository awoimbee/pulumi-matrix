import { Input, all } from "@pulumi/pulumi";

import { createNamespace } from "../../utils.js";
import deployPostgresExporter from "./postgres_exporter.js";
import deployPrometheus from "./prometheus.js";
import deployGrafana from "./grafana.js";
import deployLoki from "./loki.js";
import deployTempo from "./tempo.js";

export default async function deploy (keycloakUri: Input<string>) {
  let namespaceName = createNamespace("monitoring");
  const postgresExporter = deployPostgresExporter(namespaceName);
  const prometheus = await deployPrometheus(namespaceName);
  const grafana = deployGrafana(namespaceName, keycloakUri);
  const loki = deployLoki(namespaceName, prometheus.alertmanagerSvc);
  const tempo = deployTempo(namespaceName);

  // The namespace name is used to create service monitors.
  // This line make resources dependent on the namespace also depend
  // on the service monitor CRDS
  namespaceName = all([namespaceName, prometheus.ready]).apply(([namespaceName, _]) => namespaceName);

  return {
    namespaceName,
    postgresExporter,
    prometheus,
    grafana,
    loki,
    tempo
  };
}

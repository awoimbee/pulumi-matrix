import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import assert from "node:assert/strict";
import { deepmerge } from "deepmerge-ts";
import * as yaml from "js-yaml";
import semver from "semver";

import globals, { provider } from "./globals.js";
import { output } from "@pulumi/pulumi";

/**
 * Allows to use pulumi's input types without the hassle of Input<T>
 *
 * This allows eg: a helm chart transform to use the type k8s.types.input.core.v1.Container
 * */
export type UnwrapedInput<T> = T extends pulumi.Input<infer U> ?
  U extends object ? UnwrapInputObject<U> : U: // eslint-disable-line  no-use-before-define
  T extends object ? UnwrapInputObject<T> : T // eslint-disable-line  no-use-before-define
type UnwrapInputObject<T> = {
  [P in keyof T] : UnwrapedInput<T[P]>
}

export function notNull<T> (obj: T | undefined | null): T {
  if (obj === undefined || obj === null) {
    throw new Error("Object is not allowed to be null or undefined.");
  }
  return obj;
}

/** returns the output for our AWS-specific IAC */
export async function getAwsOutputs (): Promise<undefined | Record<string, any>> {
  const aws = await globals.refFoundationsStack.getOutputValue("aws");
  assert((aws !== undefined) === (globals.platform === "aws"));
  return aws;
}

export function createNamespace (
  name: string,
  params?: k8s.core.v1.NamespaceArgs,
  opts?: pulumi.CustomResourceOptions
) {
  const localParams = {
    metadata: {
      name,
      ...globals.defaultTags
    }
  };
  params = deepmerge(
    localParams,
    params ?? {}
  );
  opts = deepmerge(
    { provider },
    opts ?? {}
  );
  const namespace = new k8s.core.v1.Namespace(name, params, opts);
  const namespaceName = namespace.metadata.apply(m => m.name);

  return namespaceName;
}

/**
 * Deferred promise
 * Allows passing around Promises that do not have an executor.
 * This is FREAKING DANGEROUS
 * because it creates promises that, by default, never resolve.
 */
export class Deferred<T> extends Promise<T> {
  private _resolve?: (value: T | PromiseLike<T>) => void;
  private _reject?: (reason?: any) => void;

  constructor () {
    let _resolve;
    let _reject;
    super((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
    });
    this._resolve = _resolve;
    this._reject = _reject;
  }

  static get [Symbol.species] () {
    return Promise;
  }

  get [Symbol.toStringTag] () {
    return "DeferredPromise";
  }

  public resolve (val: T | PromiseLike<T>) {
    assert(this._resolve !== undefined);
    this._resolve(val);
  }

  public reject (reason?: any) {
    assert(this._reject !== undefined);
    this._reject(reason);
  }
}

/**
 * `k8s.helm.v3.Chart` with the added feature and printing a warning when the chart
 * is out of date
 */
export class HelmChart extends k8s.helm.v3.Chart {
  constructor (
    releaseName: string,
    config: k8s.helm.v3.ChartOpts,
    opts?: pulumi.ComponentResourceOptions
  ) {
    if (config.fetchOpts !== undefined && config.version !== undefined) {
      const repo = output(config.fetchOpts).apply(f => notNull(f.repo));
      pulumi.all([repo, config.chart, config.version]).apply(args =>
        this.notifyLatestChartVersion(...args)
      );
    }
    super(releaseName, config, opts);
  }

  private async notifyLatestChartVersion (repo: string, chart: string, version: string) {
    const helmIndexUrl = `${repo}/index.yaml`;
    const resp = await fetch(helmIndexUrl);
    const helmIndex = yaml.load(await resp.text()) as any;
    const releases = helmIndex?.entries?.[chart];
    let latestMetadata;
    if (semver.prerelease(version)) {
      latestMetadata = releases?.[0];
    } else {
      // skip prereleases
      latestMetadata = releases?.find((r: any) => semver.prerelease(r.version) === null);
    }
    const latestVersion = latestMetadata?.version as string | undefined;
    if (latestVersion === null || latestVersion === undefined) {
      console.error(`Could not fetch latest version of '${chart}' !`);
      return;
    }
    if (semver.satisfies(latestVersion, version)) {
      return;
    }
    console.warn(`New chart version available: ${chart} '${version}' => '${latestVersion}'.`);
  }
}

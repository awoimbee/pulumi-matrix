import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import assert from "node:assert/strict";


const project = pulumi.getProject();
const stack = pulumi.getStack();
assert(stack.startsWith(project + "."));
const stackSuffix = stack.slice(project.length + 1);

const cfg = new pulumi.Config();


export const provider = new k8s.Provider(
  "kubernetes",
  { context: "rpi4" }
);

const defaultTags = {
  project,
  stack,
};

const globals = {
  cfg,
  defaultTags,
  provider
};

export default globals;

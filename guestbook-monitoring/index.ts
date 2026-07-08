import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config();

// Falls back to a default password if the user hasn't set one via
// `pulumi config set --secret grafanaAdminPassword <password>`
const grafanaAdminPassword = config.getSecret("grafanaAdminPassword") ?? pulumi.secret("ChangeMe123!");

// Fixed NodePort for Grafana, so we can output a deterministic access URL.
// Must be in the 30000-32767 range that Kubernetes reserves for NodePorts.
const grafanaNodePort = 30030;

// ------------------------------------------------------------------
// Namespaces
// ------------------------------------------------------------------
const guestbookNs = new k8s.core.v1.Namespace("guestbook-ns", {
    metadata: { name: "guestbook" },
});

const monitoringNs = new k8s.core.v1.Namespace("monitoring-ns", {
    metadata: { name: "monitoring" },
});

// ------------------------------------------------------------------
// Guestbook: Redis Leader
// ------------------------------------------------------------------
const redisLeaderLabels = { app: "redis-leader" };

const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace: guestbookNs.metadata.name, labels: redisLeaderLabels },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        replicas: 1,
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [{
                    name: "redis-leader",
                    image: "redis:6.0.5",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{ name: "redis", containerPort: 6379 }],
                }],
            },
        },
    },
});

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: { name: "redis-leader", namespace: guestbookNs.metadata.name, labels: redisLeaderLabels },
    spec: {
        ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
        selector: redisLeaderLabels,
    },
});

// ------------------------------------------------------------------
// Guestbook: Redis Follower
// ------------------------------------------------------------------
const redisFollowerLabels = { app: "redis-follower" };

const redisFollowerDeployment = new k8s.apps.v1.Deployment("redis-follower", {
    metadata: { namespace: guestbookNs.metadata.name, labels: redisFollowerLabels },
    spec: {
        selector: { matchLabels: redisFollowerLabels },
        replicas: 2,
        template: {
            metadata: { labels: redisFollowerLabels },
            spec: {
                containers: [{
                    name: "redis-follower",
                    image: "gcr.io/google_samples/gb-redis-follower:v2",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{ name: "redis", containerPort: 6379 }],
                }],
            },
        },
    },
});

const redisFollowerService = new k8s.core.v1.Service("redis-follower", {
    metadata: { name: "redis-follower", namespace: guestbookNs.metadata.name, labels: redisFollowerLabels },
    spec: {
        ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
        selector: redisFollowerLabels,
    },
});

// ------------------------------------------------------------------
// Guestbook: Frontend
// ------------------------------------------------------------------
const frontendLabels = { app: "guestbook-frontend" };

const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: guestbookNs.metadata.name, labels: frontendLabels },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    // Annotation-based scrape config (the alternative approach named in
                    // the requirements, alongside the ServiceMonitor below).
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "80",
                    "prometheus.io/path": "/metrics",
                },
            },
            spec: {
                containers: [{
                    name: "guestbook-frontend",
                    image: "gcr.io/google-samples/gb-frontend:v5",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{ name: "http", containerPort: 80 }],
                }],
            },
        },
    },
});

const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        name: "frontend",
        namespace: guestbookNs.metadata.name,
        labels: frontendLabels,
        annotations: {
            "prometheus.io/scrape": "true",
            "prometheus.io/port": "80",
        },
    },
    spec: {
        type: "LoadBalancer",
        ports: [{ name: "http", port: 80, targetPort: 80 }],
        selector: frontendLabels,
    },
});

// ------------------------------------------------------------------
// Monitoring stack: kube-prometheus-stack (Prometheus + Grafana +
// Alertmanager + kube-state-metrics + the Prometheus Operator, which
// provides the ServiceMonitor CRD).
// ------------------------------------------------------------------
const kubePrometheusStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
    name: "kube-prometheus-stack",
    chart: "kube-prometheus-stack",
    version: "62.7.0",
    namespace: monitoringNs.metadata.name,
    timeout: 600,
    // Docker Desktop's Kubernetes can't reliably signal "ready" the way
    // Helm's --wait logic expects for every resource in a chart this size,
    // which previously caused `pulumi up` to hang until timeout. skipAwait
    // makes Pulumi return as soon as the chart is applied; pod health is
    // then checked with `kubectl` afterward instead (see README).
    skipAwait: true,
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        grafana: {
            adminPassword: grafanaAdminPassword,
            service: {
                // NodePort per the assignment's requirement ("LoadBalancer or
                // NodePort"). NodePort is used over LoadBalancer here because
                // it doesn't depend on a cloud/Docker Desktop load-balancer
                // controller assigning an external IP -- the port is just
                // opened directly, so it comes up immediately and reliably.
                type: "NodePort",
                port: 3000,
                nodePort: grafanaNodePort,
            },
        },
        prometheus: {
            prometheusSpec: {
                // Without this, the Prometheus Operator only picks up
                // ServiceMonitors carrying the chart's release label. Setting
                // these to false makes it watch ServiceMonitors/PodMonitors
                // cluster-wide, which is what we want for the guestbook ones
                // defined below.
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
            },
        },
        // Docker Desktop's Kubernetes node doesn't reliably support the
        // hostNetwork/hostPort: 9100 binding this component needs, which
        // left it stuck Pending/CrashLoopBackOff. It only provides
        // host-level metrics (host CPU/disk/network), which the assignment
        // doesn't require -- kube-state-metrics and the kubelet's built-in
        // cAdvisor (both enabled by default) fully cover per-pod resource
        // usage for the guestbook namespace.
        "prometheus-node-exporter": {
            enabled: false,
        },
    },
}, { dependsOn: [monitoringNs] });

// ------------------------------------------------------------------
// ServiceMonitor: tells Prometheus to scrape the guestbook FRONTEND
// Service.
// ------------------------------------------------------------------
const frontendServiceMonitor = new k8s.apiextensions.CustomResource("guestbook-frontend-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "guestbook-frontend",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: [guestbookNs.metadata.name] },
        selector: { matchLabels: frontendLabels },
        endpoints: [{ port: "http", path: "/metrics", interval: "30s" }],
    },
}, { dependsOn: [kubePrometheusStack] });

// ------------------------------------------------------------------
// ServiceMonitor: tells Prometheus to scrape the guestbook BACKEND
// (redis-leader + redis-follower) Services. Note: like the frontend
// target above, the upstream demo images don't expose a Prometheus
// /metrics endpoint, so these targets will show as DOWN in Prometheus --
// they're included to demonstrate the scrape configuration itself, per
// the requirement to configure monitoring for "frontend and backend
// services". Real per-pod resource usage for these pods is already live
// via kube-state-metrics / cAdvisor regardless of this ServiceMonitor.
// ------------------------------------------------------------------
const backendServiceMonitor = new k8s.apiextensions.CustomResource("guestbook-backend-servicemonitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "guestbook-backend",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: [guestbookNs.metadata.name] },
        selector: { matchExpressions: [{ key: "app", operator: "In", values: ["redis-leader", "redis-follower"] }] },
        endpoints: [{ port: "redis", path: "/metrics", interval: "30s" }],
    },
}, { dependsOn: [kubePrometheusStack] });

// ------------------------------------------------------------------
// Stretch goal: a basic Grafana dashboard, provisioned automatically
// via the Grafana sidecar that kube-prometheus-stack ships with. Any
// ConfigMap labeled grafana_dashboard=1 in the monitoring namespace is
// picked up and imported by Grafana on the fly.
// ------------------------------------------------------------------
const dashboardJson = fs.readFileSync(path.join(__dirname, "dashboards", "guestbook-dashboard.json"), "utf-8");

const grafanaDashboardConfigMap = new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: {
        name: "guestbook-dashboard",
        namespace: monitoringNs.metadata.name,
        labels: { grafana_dashboard: "1" },
    },
    data: { "guestbook-dashboard.json": dashboardJson },
}, { dependsOn: [kubePrometheusStack] });

// ------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------
export const guestbookNamespace = guestbookNs.metadata.name;
export const monitoringNamespace = monitoringNs.metadata.name;

export const grafanaUrl = `http://localhost:${grafanaNodePort}`;
export const grafanaAdminUser = "admin";
export const grafanaAdminPasswordOut = grafanaAdminPassword;

export const grafanaAccessInstructions =
    `Grafana is exposed as a NodePort Service on port ${grafanaNodePort}. On Docker Desktop, ` +
    `NodePort services are reachable directly at http://localhost:${grafanaNodePort} -- no ` +
    "port-forward needed. If that doesn't load, run: kubectl port-forward -n monitoring " +
    `svc/kube-prometheus-stack-grafana 3000:3000 and open http://localhost:3000 instead.`;

export const guestbookAccessInstructions =
    "The guestbook frontend is exposed as a LoadBalancer on port 80 (service `frontend` in the " +
    "guestbook namespace). Check `kubectl get svc -n guestbook frontend` for the EXTERNAL-IP/port, " +
    "or run: kubectl port-forward -n guestbook svc/frontend 8080:80 and open http://localhost:8080.";

export const verifyPrometheusInstructions =
    "kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090, then open " +
    "http://localhost:9090/targets and look for the `guestbook-frontend` and `guestbook-backend` " +
    "jobs, plus `kube-state-metrics` and `kubelet` (cAdvisor) targets which report real per-pod " +
    "CPU/memory for the guestbook namespace.";

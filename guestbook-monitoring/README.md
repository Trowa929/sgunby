# Guestbook + Monitoring (Pulumi / Kubernetes)

This extends the [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/blob/master/kubernetes-ts-guestbook/README.md)
with a Prometheus + Grafana monitoring stack, deployed entirely from a single
Pulumi TypeScript program.

## What gets deployed

| Component | Namespace | How |
|---|---|---|
| Redis leader + follower | `guestbook` | Plain Pulumi Kubernetes resources (Deployment + Service) |
| Guestbook frontend | `guestbook` | Deployment + `LoadBalancer` Service (port 80) |
| Prometheus, Grafana, Alertmanager, node-exporter, kube-state-metrics, Prometheus Operator | `monitoring` | `kube-prometheus-stack` Helm chart, deployed via `k8s.helm.v3.Release` |
| ServiceMonitor for the guestbook frontend | `monitoring` | Custom Resource (Prometheus Operator CRD) |
| Grafana dashboard | `monitoring` | ConfigMap picked up automatically by Grafana's dashboard sidecar |

## Prerequisites

You already have these set up:
- Docker Desktop with Kubernetes enabled
- `kubectl` pointed at the Docker Desktop cluster
- Helm 3
- Pulumi CLI, logged in locally (`pulumi login --local`)
- Node.js / npm

## Deploy

```bash
cd guestbook-monitoring
npm install

pulumi stack init dev

# Optional: set your own Grafana admin password (recommended).
# If you skip this, a default password is used (see index.ts).
pulumi config set --secret grafanaAdminPassword "YourStrongPassword123!"

pulumi up
```

Review the plan and confirm. The first `pulumi up` takes a few minutes because
it has to pull the `kube-prometheus-stack` Helm chart and its container images
(Prometheus, Grafana, Alertmanager, exporters).

When it finishes, view the outputs:

```bash
pulumi stack output
```

## Accessing Grafana

Grafana is exposed as a **NodePort** Service on port **30030**
(`kube-prometheus-stack-grafana` in the `monitoring` namespace).

On Docker Desktop, NodePort services are reachable directly at:

**http://localhost:30030**

No port-forward needed. If that doesn't load for some reason, fall back to:

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:3000
```

then open **http://localhost:3000**.

**Credentials:**
- Username: `admin`
- Password: whatever you set with `pulumi config set --secret grafanaAdminPassword ...`
  (or run `pulumi stack output grafanaAdminPasswordOut --show-secrets` to see it)

## Accessing the Guestbook

```bash
kubectl get svc -n guestbook frontend
```

Open **http://localhost:80** once `EXTERNAL-IP` is set, or:

```bash
kubectl port-forward -n guestbook svc/frontend 8080:80
```

then open **http://localhost:8080**.

## Verifying Prometheus is scraping the Guestbook

1. Port-forward Prometheus:

   ```bash
   kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
   ```

2. Open **http://localhost:9090/targets**.

3. You should see:
   - A `guestbook-frontend` job/target and a `guestbook-backend` job/target
     (covering `redis-leader` and `redis-follower`), both created by the
     `ServiceMonitor` resources in `index.ts`. **Note:** the stock demo
     images used by the upstream Guestbook example (`gb-frontend`,
     `redis`, `gb-redis-follower`) don't expose a `/metrics` HTTP endpoint,
     so these targets will show as `DOWN` — this is expected, and they're
     included specifically to demonstrate the scrape wiring end-to-end for
     both the frontend and backend as the assignment asks for. In a real
     service you'd add a metrics library (e.g. `prom-client`) or a sidecar
     exporter to make these targets `UP`.
   - `kube-state-metrics` and `kubelet`/`cadvisor` targets, which **are**
     live and already report real per-pod CPU, memory, and pod-phase metrics
     for every pod in the `guestbook` namespace — this is what satisfies the
     "resource usage" metrics requirement without needing any changes to the
     guestbook application itself.

4. Try these queries in the Prometheus "Graph" tab to confirm data is
   flowing:

   ```
   sum(container_cpu_usage_seconds_total{namespace="guestbook"}) by (pod)
   sum(container_memory_working_set_bytes{namespace="guestbook"}) by (pod)
   kube_pod_status_phase{namespace="guestbook"}
   ```

## Grafana dashboard (stretch goal)

A "Guestbook Application" dashboard is provisioned automatically (via a
labeled `ConfigMap` picked up by Grafana's built-in dashboard sidecar). In
Grafana, go to **Dashboards → Guestbook Application** to see:

- Guestbook pod CPU usage
- Guestbook pod memory usage
- Running pod count per guestbook component
- Frontend scrape target `up`/`down` status

## Cleaning up

```bash
pulumi destroy
```

## Notes / design decisions

- **Helm vs. raw manifests:** the monitoring stack uses the community
  `kube-prometheus-stack` Helm chart (via `k8s.helm.v3.Release`) rather than
  hand-rolled manifests, since it bundles Prometheus, Grafana, Alertmanager,
  the Prometheus Operator (which provides the `ServiceMonitor` CRD),
  node-exporter, and kube-state-metrics as a single coherent, well-maintained
  unit.
- **Ports:** Grafana's `LoadBalancer` Service uses port 3000 instead of 80 so
  it doesn't collide with the guestbook frontend's own port-80
  `LoadBalancer` Service — Docker Desktop maps all `LoadBalancer` external
  IPs to `localhost`, so distinct ports are required to reach each service.
- **`serviceMonitorSelectorNilUsesHelmValues: false`** is set on the
  Prometheus custom resource so the Prometheus Operator watches
  `ServiceMonitor`s across the whole cluster instead of only ones created by
  the Helm release itself — otherwise our guestbook `ServiceMonitor` would be
  silently ignored.

# Guestbook Application with Prometheus & Grafana Monitoring

![Architecture Diagram](./architecture.svg)

A production-grade Kubernetes deployment of the Guestbook application, extended with full observability — Prometheus metrics, Grafana dashboards, Apache sidecar exporter, and security hardening. Deployed via **Pulumi TypeScript IaC** on a 4-node Minikube cluster with node isolation.

---

## Quick Start (Pulumi — recommended)

```bash
# 1. clone
git clone https://github.com/rastin-ghasemi/kubernetes-guestbook-monitoring.git
cd kubernetes-guestbook-monitoring

# 2. start the cluster
minikube start --nodes=4 --driver=docker --cpus=4 --memory=6144
kubectl get nodes   # wait until all 4 are Ready

# 3. enable addons BEFORE tainting nodes
minikube addons enable ingress
minikube addons enable metrics-server

# wait for ingress controller to be ready on the control plane
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller \
  -n ingress-nginx \
  --timeout=120s

# 4. label and taint nodes
kubectl label node minikube-m02 tier=backend && kubectl taint node minikube-m02 tier=backend:NoSchedule
kubectl label node minikube-m03 tier=frontend && kubectl taint node minikube-m03 tier=frontend:NoSchedule
kubectl label node minikube-m04 tier=ingress  && kubectl taint node minikube-m04 tier=ingress:NoSchedule

# 5. move ingress controller to dedicated ingress node
kubectl patch deployment ingress-nginx-controller -n ingress-nginx --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/nodeSelector","value":{"kubernetes.io/os":"linux","tier":"ingress"}}]'
kubectl patch deployment ingress-nginx-controller -n ingress-nginx \
  --patch '{"spec":{"template":{"spec":{"tolerations":[{"key":"tier","operator":"Equal","value":"ingress","effect":"NoSchedule"}]}}}}'

# wait for ingress to move to minikube-m04
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
kubectl get pods -n ingress-nginx -o wide   # Expected: Running on minikube-m04

# 6. pre-pull images on the correct nodes
minikube ssh -n minikube-m02 -- docker pull registry.k8s.io/redis@sha256:cb111d1bd870a6a471385a4a69ad17469d326e9dd91e0e455350cacf36e1b3ee
minikube ssh -n minikube-m02 -- docker pull us-docker.pkg.dev/google-samples/containers/gke/gb-redis-follower:v2
minikube ssh -n minikube-m03 -- docker pull us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5
minikube ssh -n minikube-m03 -- docker pull bitnami/apache-exporter:latest

# 7. deploy everything with Pulumi
cd pulumi-guestbook
rm -rf node_modules package-lock.json
npm install
pulumi login
pulumi stack init dev || pulumi stack select dev
pulumi config set grafanaPassword admin123
pulumi refresh --yes   # sync state with actual cluster
pulumi up --yes

# 8. add local DNS (use minikube-m04 IP — NOT minikube ip)
echo "192.168.49.5 guestbook.local grafana.local" | sudo tee -a /etc/hosts
```

**That's it.** Open `http://guestbook.local` for the app and `http://grafana.local` for dashboards.

---

## Grafana Access

| | |
|---|---|
| URL | http://grafana.local |
| Username | `admin` |
| Password | `admin123` |
| Home dashboard | Guestbook — Full Stack Overview (auto-loads on login) |

---

## Architecture

```
minikube        → control plane
minikube-m02    → guestbook-backend   (Redis leader + 2 followers)
minikube-m03    → guestbook-frontend  (PHP app + apache-exporter sidecar) + monitoring
minikube-m04    → ingress-nginx       (Nginx ingress controller)
```

| Namespace | Contents |
|---|---|
| `guestbook-backend` | Redis leader + followers |
| `guestbook-frontend` | PHP frontend + apache-exporter sidecar (port 9117) |
| `monitoring` | Prometheus + Grafana + Alertmanager + node-exporters |
| `ingress-nginx` | Nginx ingress controller |

---

## What Pulumi Deploys (38 resources)

| Category | Resources |
|---|---|
| Namespaces | guestbook-backend, guestbook-frontend, monitoring |
| Guestbook | Redis leader + follower deployments + services, PHP frontend + service |
| Monitoring | kube-prometheus-stack Helm release (Prometheus + Grafana + Alertmanager) |
| Scraping | ServiceMonitor for frontend (port 9117) + ServiceMonitor for Redis |
| Ingress | guestbook-ingress → guestbook.local, grafana-ingress → grafana.local |
| Dashboards | 3 Grafana dashboard ConfigMaps (auto-loaded by Grafana sidecar) |
| Security | 3 LimitRanges, 3 ResourceQuotas, 3 PodDisruptionBudgets, 9 NetworkPolicies, 2 Secrets |

---

## Verifying Prometheus Scraping

```bash
# port-forward to Prometheus
kubectl port-forward svc/prometheus-prometheus 9090:9090 -n monitoring

# open http://localhost:9090/targets
# look for: serviceMonitor/monitoring/frontend-monitor → 2/2 UP
```

Verify Apache metrics directly from the pod:
```bash
POD=$(kubectl get pods -n guestbook-frontend -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -n guestbook-frontend -c php-redis -- curl -s http://localhost:9117/metrics | head -20
```

Expected output:
```
# HELP apache_accesses_total Current total apache accesses
apache_accesses_total 42
apache_workers{state="busy"} 2
apache_workers{state="idle"} 6
apache_cpuload 0.0012
```

---

## Grafana Dashboards

| Dashboard | Panels |
|---|---|
| Guestbook — Full Stack Overview | Pod counts, request rate, Apache workers, CPU/memory, restarts |
| Guestbook Frontend — Apache Metrics | Request rate, busy/idle workers, CPU load, replicas available |
| Kubernetes — Pod Resources | CPU and memory per pod across both namespaces |

Dashboards load automatically via Grafana's sidecar watching ConfigMaps with label `grafana_dashboard=1`. The overview dashboard is set as the Grafana home page via `grafana.ini`.

---

## Key Prometheus Queries

| Metric | Query |
|---|---|
| HTTP request rate | `rate(apache_accesses_total[5m])` |
| Apache busy workers | `apache_workers{state="busy"}` |
| Apache idle workers | `apache_workers{state="idle"}` |
| Apache CPU load | `apache_cpuload` |
| Pod memory | `container_memory_working_set_bytes{namespace="guestbook-frontend", pod=~"frontend-.*"}` |
| Pod CPU | `rate(container_cpu_usage_seconds_total{namespace="guestbook-frontend", pod=~"frontend-.*"}[5m])` |
| Redis pods running | `kube_pod_status_phase{namespace="guestbook-backend", phase="Running"}` |
| Frontend replicas | `kube_deployment_status_replicas_available{namespace="guestbook-frontend"}` |
| Pod restarts | `kube_pod_container_status_restarts_total{namespace=~"guestbook-frontend|guestbook-backend"}` |

---

## Security

```
Internet
    │
    ▼
ingress-nginx (minikube-m04)
    ├── :80   → guestbook-frontend  (allow-ingress-to-frontend)
    └── :3000 → monitoring/grafana  (allow-ingress-to-grafana)

guestbook-frontend
    └── :6379 → guestbook-backend   (allow-frontend-to-redis)
                Redis — default-deny blocks everything else

monitoring
    ├── :9117 → guestbook-frontend  (allow-monitoring-to-frontend)
    └── :any  → guestbook-backend   (allow-monitoring-to-backend)
                internal free communication (allow-intra-monitoring)
```

| Layer | Resource | Purpose |
|---|---|---|
| NetworkPolicy | default-deny-ingress (×3) | default-deny in every namespace |
| NetworkPolicy | allow-frontend-to-redis | only frontend reaches Redis on :6379 |
| NetworkPolicy | allow-monitoring-* | only Prometheus scrapes metrics endpoints |
| NetworkPolicy | allow-ingress-* | only Nginx reaches frontend and Grafana |
| LimitRange | backend / frontend / monitoring | inject default CPU/memory limits for all pods |
| ResourceQuota | backend / frontend / monitoring | cap total resource consumption per namespace |
| PodDisruptionBudget | redis-leader-pdb | leader protected — 0 voluntary disruptions allowed |
| PodDisruptionBudget | redis-follower-pdb | at least 1 follower always available |
| PodDisruptionBudget | frontend-pdb | at least 1 frontend pod always serving |
| Secret | grafana-credentials, redis-credentials | credentials in K8s secrets, not hardcoded |

---

## How Metrics Flow

```
Apache (PHP pod)
  └── mod_status → /server-status?auto
        └── apache-exporter sidecar reads it
              └── exposes Prometheus metrics on :9117
                    └── ServiceMonitor tells Prometheus to scrape :9117
                          └── Prometheus stores time-series data
                                └── Grafana queries Prometheus
                                      └── ConfigMap dashboards auto-load via sidecar
                                            └── live charts in the browser
```

---

## Prerequisites

- Docker
- `minikube` v1.38+
- `kubectl`
- `helm` (Approach A only)
- Node.js **v20.19.0+** or **v22.12.0+** and `npm` (Approach B only)
- Pulumi CLI (Approach B only): `curl -fsSL https://get.pulumi.com | sh`

> **Node.js version note.** Pulumi requires Node v20.19.0+ or v22.12.0+. If you get a `SourceMapConsumer is not a constructor` error, you are on an incompatible Node version. Use nvm to switch:
> ```bash
> nvm install 20
> nvm use 20
> node --version   # must show v20.19.0 or higher
> # then do a clean reinstall
> rm -rf node_modules package-lock.json
> npm install
> ```

---

## Approach A — Manual Deployment (kubectl + helm)

> For learning and understanding each component individually. Complete these Common Setup steps first, then follow A1–A8.

### Common setup (required for both approaches)

```bash
# start cluster
minikube start --nodes=4 --driver=docker --cpus=4 --memory=6144
kubectl get nodes   # wait until all 4 are Ready

# enable addons BEFORE tainting
minikube addons enable ingress
minikube addons enable metrics-server
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller \
  -n ingress-nginx --timeout=120s

# label and taint nodes
kubectl label node minikube-m02 tier=backend && kubectl taint node minikube-m02 tier=backend:NoSchedule
kubectl label node minikube-m03 tier=frontend && kubectl taint node minikube-m03 tier=frontend:NoSchedule
kubectl label node minikube-m04 tier=ingress  && kubectl taint node minikube-m04 tier=ingress:NoSchedule

# move ingress to m04
kubectl patch deployment ingress-nginx-controller -n ingress-nginx --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/nodeSelector","value":{"kubernetes.io/os":"linux","tier":"ingress"}}]'
kubectl patch deployment ingress-nginx-controller -n ingress-nginx \
  --patch '{"spec":{"template":{"spec":{"tolerations":[{"key":"tier","operator":"Equal","value":"ingress","effect":"NoSchedule"}]}}}}'
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx

# pre-pull images
minikube ssh -n minikube-m02 -- docker pull registry.k8s.io/redis@sha256:cb111d1bd870a6a471385a4a69ad17469d326e9dd91e0e455350cacf36e1b3ee
minikube ssh -n minikube-m02 -- docker pull us-docker.pkg.dev/google-samples/containers/gke/gb-redis-follower:v2
minikube ssh -n minikube-m03 -- docker pull us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5
minikube ssh -n minikube-m03 -- docker pull bitnami/apache-exporter:latest
```

### A1 — Create namespaces

```bash
kubectl create namespace guestbook-backend
kubectl create namespace guestbook-frontend
kubectl create namespace monitoring
```

### A2 — Deploy guestbook

```bash
cd k8s/
kubectl apply -f BackEnd/Redis-Leader-Deployment.yaml
kubectl apply -f SVC-Redis-Leader.yaml
kubectl apply -f BackEnd/Redis-Follower-Deployment.yaml
kubectl apply -f SVC-Redis-Follower.yaml
kubectl apply -f FrontEnd/Front-Deploy.yaml
kubectl apply -f FrontEnd/Frontend-service.yaml
```

Verify:
```bash
kubectl get pods -n guestbook-backend   # 3 Running on minikube-m02
kubectl get pods -n guestbook-frontend  # 2/2 Running on minikube-m03
```

Verify Redis replication:
```bash
kubectl logs deployment/redis-leader -n guestbook-backend | grep -i slave
# Expected: Synchronization with slave xxx succeeded (x2)
```

Verify Apache metrics sidecar:
```bash
POD=$(kubectl get pods -n guestbook-frontend -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -n guestbook-frontend -c php-redis -- curl -s http://localhost:9117/metrics | head -10
```

### A3 — Create ingress and DNS

```bash
cd k8s/
kubectl apply -f ingress.yaml
echo "192.168.49.5 guestbook.local grafana.local" | sudo tee -a /etc/hosts
curl -I http://guestbook.local   # Expected: HTTP 200 OK
```

### A4 — Deploy monitoring stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values k8s/Monitoring/kube-prometheus-stack-values.yaml \
  --wait --timeout 15m
```

Verify:
```bash
kubectl get pods -n monitoring
# Expected: grafana 3/3, prometheus 2/2, alertmanager 2/2, node-exporter x4
```

### A5 — Apply ServiceMonitors

```bash
kubectl apply -f k8s/Monitoring/servicemonitor-frontend.yaml
kubectl apply -f k8s/Monitoring/servicemonitor-redis.yaml
```

### A6 — Load Grafana dashboards

```bash
cd k8s/Monitoring/DashBoard-json/
for dashboard in *.json; do
  name=$(basename $dashboard .json)
  kubectl create configmap $name \
    --from-file=$dashboard --namespace monitoring \
    --dry-run=client -o yaml | \
    kubectl label --local -f - grafana_dashboard=1 -o yaml | \
    kubectl apply -f -
done
```

### A7 — Apply security hardening

```bash
kubectl apply -f k8s/Security/secrets.yaml
kubectl apply -f k8s/Security/resource-quotas.yaml
kubectl apply -f k8s/Security/pod-disruption-budgets.yaml
kubectl apply -f k8s/Security/network-policies.yaml
```

Verify services still work after network policies:
```bash
curl -I http://guestbook.local   # HTTP 200 OK
curl -I http://grafana.local     # HTTP 302 Found
```

### A8 — Verify full stack

```bash
kubectl get pods -n guestbook-backend -o wide   # minikube-m02
kubectl get pods -n guestbook-frontend -o wide  # minikube-m03
kubectl get pods -n monitoring -o wide          # minikube-m03
kubectl get pods -n ingress-nginx -o wide       # minikube-m04
kubectl get netpol --all-namespaces
kubectl get quota --all-namespaces
kubectl get pdb --all-namespaces
```

---

## Approach B — Pulumi Deployment (TypeScript IaC)

> The entire stack in a single `index.ts` file. One command to deploy everything.
> Complete the Common Setup steps from Approach A first (cluster, addons, taints, ingress patch, image pre-pull), then follow B1–B5.

### B1 — Install Pulumi

```bash
curl -fsSL https://get.pulumi.com | sh && source ~/.bashrc
pulumi version
```

### B2 — Set up and deploy

```bash
cd pulumi-guestbook/

# clean install to avoid stale node_modules from a different Node version
rm -rf node_modules package-lock.json
npm install

pulumi login

# create a new stack (or select if it already exists)
pulumi stack init dev || pulumi stack select dev

pulumi config set grafanaPassword admin123

# refresh syncs Pulumi state with the actual cluster (important after minikube delete)
pulumi refresh --yes
pulumi up --yes
```

Stack outputs after deployment:
```
frontendUrl          : "http://guestbook.local ..."
grafanaUrl           : "http://grafana.local ..."
grafanaAdminUser     : "admin"
grafanaAdminPassword : "admin123"
addHostsCommand      : "echo '192.168.49.5 ...' | sudo tee -a /etc/hosts"
verifyScrapingCommand: "kubectl port-forward svc/prometheus-prometheus 9090:9090 -n monitoring"
verifyMetricsCommand : "POD=$(kubectl get pods ...) && kubectl exec ..."
```

### B3 — Add local DNS

```bash
echo "192.168.49.5 guestbook.local grafana.local" | sudo tee -a /etc/hosts
```

> Use `192.168.49.5` (minikube-m04 IP) — not `minikube ip` which returns the control plane IP.

### B4 — Verify

```bash
curl -I http://guestbook.local   # HTTP 200 OK
curl -I http://grafana.local     # HTTP 302 Found → /login

kubectl get pods -n guestbook-backend -o wide   # minikube-m02
kubectl get pods -n guestbook-frontend -o wide  # minikube-m03
kubectl get pods -n monitoring -o wide          # minikube-m03
kubectl get pods -n ingress-nginx -o wide       # minikube-m04
```

Open Grafana at `http://grafana.local` — the **Guestbook Full Stack Overview** dashboard loads as the home page automatically.

### B5 — Destroy

```bash
pulumi destroy --yes   # removes all Pulumi-managed K8s resources
minikube delete        # deletes the cluster
```

> After destroying and recreating the cluster, always run `pulumi refresh --yes` before `pulumi up` to sync Pulumi's state with the new cluster.

---

## File Structure

```
kubernetes-guestbook-monitoring/
├── architecture.svg
├── README.md
├── pulumi-guestbook/
│   ├── index.ts                 ← entire stack (38 resources)
│   ├── Pulumi.yaml
│   ├── Pulumi.dev.yaml
│   └── package.json
└── k8s/
    ├── BackEnd/
    │   ├── Redis-Leader-Deployment.yaml
    │   └── Redis-Follower-Deployment.yaml
    ├── FrontEnd/
    │   ├── Front-Deploy.yaml        ← php-redis + apache-exporter sidecar
    │   └── Frontend-service.yaml    ← ClusterIP ports 80 + 9117
    ├── Monitoring/
    │   ├── kube-prometheus-stack-values.yaml
    │   ├── servicemonitor-frontend.yaml
    │   ├── servicemonitor-redis.yaml
    │   └── DashBoard-json/
    │       ├── apache-frontend-dashboard.json
    │       ├── guestbook-overview-dashboard.json
    │       ├── kubernetes-pods-dashboard.json
    │       ├── network-connectivity-dashboard.json
    │       └── redis-sync-dashboard.json
    ├── Security/
    │   ├── network-policies.yaml
    │   ├── resource-quotas.yaml
    │   ├── pod-disruption-budgets.yaml
    │   └── secrets.yaml
    ├── SVC-Redis-Leader.yaml
    ├── SVC-Redis-Follower.yaml
    └── ingress.yaml
```

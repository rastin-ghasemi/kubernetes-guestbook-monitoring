import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// CONFIG
// ============================================================
const config = new pulumi.Config();
const grafanaPassword = config.get("grafanaPassword") || "admin123";
const useLoadBalancer = config.getBoolean("useLoadBalancer") || false;

// ============================================================
// NAMESPACES
// ============================================================
const backendNs = new k8s.core.v1.Namespace("guestbook-backend", {
    metadata: { name: "guestbook-backend" },
});

const frontendNs = new k8s.core.v1.Namespace("guestbook-frontend", {
    metadata: { name: "guestbook-frontend" },
});

const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// ============================================================
// REDIS LEADER
// ============================================================
const redisLeaderLabels = { app: "redis", role: "leader", tier: "backend" };

const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { name: "redis-leader", namespace: "guestbook-backend" },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "redis", role: "leader" } },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [{
                    name: "leader",
                    image: "registry.k8s.io/redis@sha256:cb111d1bd870a6a471385a4a69ad17469d326e9dd91e0e455350cacf36e1b3ee",
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "200m", memory: "200Mi" },
                    },
                    ports: [{ containerPort: 6379 }],
                    livenessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 15, periodSeconds: 20 },
                    readinessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 5, periodSeconds: 10 },
                }],
                nodeSelector: { tier: "backend" },
                tolerations: [{ key: "tier", operator: "Equal", value: "backend", effect: "NoSchedule" }],
            },
        },
    },
}, { dependsOn: backendNs });

const redisLeaderService = new k8s.core.v1.Service("redis-leader-svc", {
    metadata: { name: "redis-leader", namespace: "guestbook-backend", labels: redisLeaderLabels },
    spec: {
        type: "ClusterIP",
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: { app: "redis", role: "leader", tier: "backend" },
    },
}, { dependsOn: redisLeaderDeployment });

// ============================================================
// REDIS FOLLOWER
// ============================================================
const redisFollowerLabels = { app: "redis", role: "follower", tier: "backend" };

const redisFollowerDeployment = new k8s.apps.v1.Deployment("redis-follower", {
    metadata: { name: "redis-follower", namespace: "guestbook-backend" },
    spec: {
        replicas: 2,
        selector: { matchLabels: { app: "redis", role: "follower" } },
        template: {
            metadata: { labels: redisFollowerLabels },
            spec: {
                containers: [{
                    name: "follower",
                    image: "us-docker.pkg.dev/google-samples/containers/gke/gb-redis-follower:v2",
                    resources: {
                        requests: { cpu: "100m", memory: "100Mi" },
                        limits: { cpu: "200m", memory: "200Mi" },
                    },
                    ports: [{ containerPort: 6379 }],
                    livenessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 15, periodSeconds: 20 },
                    readinessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 5, periodSeconds: 10 },
                }],
                nodeSelector: { tier: "backend" },
                tolerations: [{ key: "tier", operator: "Equal", value: "backend", effect: "NoSchedule" }],
            },
        },
    },
}, { dependsOn: redisLeaderService });

const redisFollowerService = new k8s.core.v1.Service("redis-follower-svc", {
    metadata: { name: "redis-follower", namespace: "guestbook-backend", labels: redisFollowerLabels },
    spec: {
        type: "ClusterIP",
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: { app: "redis", role: "follower", tier: "backend" },
    },
}, { dependsOn: redisFollowerDeployment });

// ============================================================
// FRONTEND (PHP + apache-exporter sidecar)
// ============================================================
const frontendLabels = { app: "guestbook", tier: "frontend" };

const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { name: "frontend", namespace: "guestbook-frontend" },
    spec: {
        replicas: 2,
        selector: { matchLabels: frontendLabels },
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9117",
                    "prometheus.io/path": "/metrics",
                },
            },
            spec: {
                containers: [
                    {
                        name: "php-redis",
                        image: "us-docker.pkg.dev/google-samples/containers/gke/gb-frontend:v5",
                        env: [
                            { name: "GET_HOSTS_FROM", value: "env" },
                            { name: "REDIS_LEADER_SERVICE_HOST", value: "redis-leader.guestbook-backend.svc.cluster.local" },
                            { name: "REDIS_FOLLOWER_SERVICE_HOST", value: "redis-follower.guestbook-backend.svc.cluster.local" },
                        ],
                        resources: {
                            requests: { cpu: "100m", memory: "100Mi" },
                            limits: { cpu: "200m", memory: "200Mi" },
                        },
                        ports: [{ name: "http", containerPort: 80 }],
                        livenessProbe: { httpGet: { path: "/", port: 80 }, initialDelaySeconds: 15, periodSeconds: 20 },
                        readinessProbe: { httpGet: { path: "/", port: 80 }, initialDelaySeconds: 5, periodSeconds: 10 },
                        lifecycle: {
                            postStart: {
                                exec: {
                                    command: ["/bin/sh", "-c",
                                        [
                                            "echo 'ExtendedStatus On' >> /etc/apache2/apache2.conf",
                                            "echo '<Location /server-status>' >> /etc/apache2/apache2.conf",
                                            "echo '  SetHandler server-status' >> /etc/apache2/apache2.conf",
                                            "echo '  Require local' >> /etc/apache2/apache2.conf",
                                            "echo '</Location>' >> /etc/apache2/apache2.conf",
                                            "apache2ctl graceful",
                                        ].join(" && "),
                                    ],
                                },
                            },
                        },
                    },
                    {
                        name: "apache-exporter",
                        image: "bitnami/apache-exporter:latest",
                        imagePullPolicy: "IfNotPresent",
                        args: ["--scrape_uri=http://localhost/server-status?auto"],
                        ports: [{ name: "metrics", containerPort: 9117 }],
                        resources: {
                            requests: { cpu: "50m", memory: "50Mi" },
                            limits: { cpu: "100m", memory: "100Mi" },
                        },
                        livenessProbe: { httpGet: { path: "/metrics", port: 9117 }, initialDelaySeconds: 20, periodSeconds: 20 },
                        readinessProbe: { httpGet: { path: "/metrics", port: 9117 }, initialDelaySeconds: 10, periodSeconds: 10 },
                    },
                ],
                nodeSelector: { tier: "frontend" },
                tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
            },
        },
    },
}, { dependsOn: [frontendNs, redisFollowerService] });

const frontendService = new k8s.core.v1.Service("frontend-svc", {
    metadata: { name: "frontend", namespace: "guestbook-frontend", labels: frontendLabels },
    spec: {
        type: useLoadBalancer ? "LoadBalancer" : "NodePort",
        ports: [
            { name: "http", port: 80, targetPort: 80, nodePort: useLoadBalancer ? undefined : 30007 },
            { name: "metrics", port: 9117, targetPort: 9117 },
        ],
        selector: frontendLabels,
    },
}, { dependsOn: frontendDeployment });

// ============================================================
// PROMETHEUS + GRAFANA via Helm
// ============================================================
const prometheusStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
    name: "kube-prometheus-stack",
    chart: "kube-prometheus-stack",
    version: "87.3.0",
    namespace: "monitoring",
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    timeout: 900,
    values: {
        fullnameOverride: "prometheus",
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
                retention: "7d",
                resources: {
                    requests: { cpu: "200m", memory: "400Mi" },
                    limits: { cpu: "500m", memory: "800Mi" },
                },
                nodeSelector: { tier: "frontend" },
                tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
            },
        },
        grafana: {
            enabled: true,
            adminPassword: grafanaPassword,
            service: {
                type: useLoadBalancer ? "LoadBalancer" : "NodePort",
                nodePort: useLoadBalancer ? undefined : 30080,
            },
            resources: {
                requests: { cpu: "100m", memory: "100Mi" },
                limits: { cpu: "200m", memory: "200Mi" },
            },
            nodeSelector: { tier: "frontend" },
            tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
            sidecar: {
                dashboards: {
                    enabled: true,
                    searchNamespace: "ALL",
                    label: "grafana_dashboard",
                    labelValue: "1",
                    folder: "/tmp/dashboards",
                },
            },
            "grafana.ini": {
                dashboards: {
                    default_home_dashboard_path: "/tmp/dashboards/guestbook-overview.json",
                },
            },
        },
        alertmanager: {
            alertmanagerSpec: {
                resources: {
                    requests: { cpu: "50m", memory: "50Mi" },
                    limits: { cpu: "100m", memory: "100Mi" },
                },
                nodeSelector: { tier: "frontend" },
                tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
            },
        },
        // node-exporter is a DaemonSet that must run on every node (including tainted ones)
        // so it tolerates all our custom taints to collect host-level metrics cluster-wide
        nodeExporter: {
            enabled: true,
            tolerations: [
                { key: "tier", operator: "Exists", effect: "NoSchedule" },
            ],
        },
        kubeStateMetrics: { enabled: true },
        // kube-state-metrics pod itself also needs to land on the frontend/monitoring node
        "kube-state-metrics": {
            nodeSelector: { tier: "frontend" },
            tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
        },
        kubeEtcd: { enabled: false },
        kubeControllerManager: { enabled: false },
        kubeScheduler: { enabled: false },
        prometheusOperator: {
            nodeSelector: { tier: "frontend" },
            tolerations: [{ key: "tier", operator: "Equal", value: "frontend", effect: "NoSchedule" }],
            // admission webhook jobs also need tolerations to schedule on tainted nodes
            admissionWebhooks: {
                patch: {
                    tolerations: [
                        { key: "tier", operator: "Exists", effect: "NoSchedule" },
                    ],
                },
            },
        },
    },
}, { dependsOn: monitoringNs });

// ============================================================
// SERVICEMONITOR — frontend
// ============================================================
const frontendServiceMonitor = new k8s.apiextensions.CustomResource("frontend-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "frontend-monitor",
        namespace: "monitoring",
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: ["guestbook-frontend"] },
        selector: { matchLabels: { app: "guestbook", tier: "frontend" } },
        endpoints: [{ port: "metrics", interval: "15s", path: "/metrics" }],
    },
}, { dependsOn: prometheusStack });

// ============================================================
// SERVICEMONITOR — redis
// ============================================================
const redisServiceMonitor = new k8s.apiextensions.CustomResource("redis-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-monitor",
        namespace: "monitoring",
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: ["guestbook-backend"] },
        selector: { matchLabels: { app: "redis" } },
        endpoints: [{ port: "redis", interval: "15s" }],
    },
}, { dependsOn: prometheusStack });

// ============================================================
// INGRESS — guestbook + grafana
// ============================================================
const guestbookIngress = new k8s.networking.v1.Ingress("guestbook-ingress", {
    metadata: {
        name: "guestbook-ingress",
        namespace: "guestbook-frontend",
        annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
    },
    spec: {
        ingressClassName: "nginx",
        rules: [{
            host: "guestbook.local",
            http: {
                paths: [{
                    path: "/",
                    pathType: "Prefix",
                    backend: { service: { name: "frontend", port: { number: 80 } } },
                }],
            },
        }],
    },
}, { dependsOn: frontendService });

const grafanaIngress = new k8s.networking.v1.Ingress("grafana-ingress", {
    metadata: {
        name: "grafana-ingress",
        namespace: "monitoring",
        annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
    },
    spec: {
        ingressClassName: "nginx",
        rules: [{
            host: "grafana.local",
            http: {
                paths: [{
                    path: "/",
                    pathType: "Prefix",
                    backend: { service: { name: "kube-prometheus-stack-grafana", port: { number: 80 } } },
                }],
            },
        }],
    },
}, { dependsOn: prometheusStack });

// ============================================================
// GRAFANA DASHBOARDS — via ConfigMaps (sidecar auto-loads)
// ============================================================
const dashboardLabels = { grafana_dashboard: "1" };

const overviewDashboard = new k8s.core.v1.ConfigMap("guestbook-overview-dashboard", {
    metadata: {
        name: "guestbook-overview-dashboard",
        namespace: "monitoring",
        labels: dashboardLabels,
        annotations: {
            // marks this as the default home dashboard
            "grafana_folder": "Guestbook",
        },
    },
    data: {
        "guestbook-overview.json": JSON.stringify({
            title: "Guestbook — Full Stack Overview",
            uid: "guestbook-overview",
            refresh: "10s",
            schemaVersion: 38,
            version: 1,
            panels: [
                { title: "Frontend Pods Running", type: "stat", gridPos: { h: 4, w: 6, x: 0, y: 0 }, targets: [{ expr: `count(kube_pod_status_phase{namespace="guestbook-frontend", phase="Running"})`, legendFormat: "Frontend pods" }], fieldConfig: { defaults: { color: { mode: "thresholds" }, thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 1 }, { color: "green", value: 2 }] } } } },
                { title: "Redis Pods Running", type: "stat", gridPos: { h: 4, w: 6, x: 6, y: 0 }, targets: [{ expr: `count(kube_pod_status_phase{namespace="guestbook-backend", phase="Running"})`, legendFormat: "Redis pods" }], fieldConfig: { defaults: { color: { mode: "thresholds" }, thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 2 }, { color: "green", value: 3 }] } } } },
                { title: "Apache Request Rate (req/s)", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 4 }, targets: [{ expr: "sum(rate(apache_accesses_total[5m]))", legendFormat: "Total req/s" }] },
                { title: "Apache Workers", type: "timeseries", gridPos: { h: 8, w: 12, x: 12, y: 4 }, targets: [{ expr: `sum(apache_workers{state="busy"})`, legendFormat: "Busy" }, { expr: `sum(apache_workers{state="idle"})`, legendFormat: "Idle" }] },
                { title: "Pod CPU Usage", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 12 }, targets: [{ expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook-frontend", pod=~"frontend-.*"}[5m]))`, legendFormat: "{{pod}}" }] },
                { title: "Pod Memory Usage", type: "timeseries", gridPos: { h: 8, w: 12, x: 12, y: 12 }, targets: [{ expr: `sum by (pod) (container_memory_working_set_bytes{namespace="guestbook-frontend", pod=~"frontend-.*"})`, legendFormat: "{{pod}}" }], fieldConfig: { defaults: { unit: "bytes" } } },
                { title: "Pod Restarts", type: "timeseries", gridPos: { h: 8, w: 24, x: 0, y: 20 }, targets: [{ expr: `kube_pod_container_status_restarts_total{namespace=~"guestbook-frontend|guestbook-backend"}`, legendFormat: "{{namespace}} / {{pod}}" }] },
            ],
        }),
    },
}, { dependsOn: prometheusStack });

const apacheDashboard = new k8s.core.v1.ConfigMap("apache-frontend-dashboard", {
    metadata: { name: "apache-frontend-dashboard", namespace: "monitoring", labels: dashboardLabels },
    data: {
        "apache-frontend.json": JSON.stringify({
            title: "Guestbook Frontend — Apache Metrics",
            uid: "apache-frontend",
            refresh: "10s",
            schemaVersion: 38,
            version: 1,
            panels: [
                { title: "Request Rate (req/s)", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 0 }, targets: [{ expr: "rate(apache_accesses_total[5m])", legendFormat: "{{pod}}" }] },
                { title: "Busy Workers", type: "stat", gridPos: { h: 4, w: 6, x: 12, y: 0 }, targets: [{ expr: `sum(apache_workers{state="busy"})`, legendFormat: "Busy" }], fieldConfig: { defaults: { color: { mode: "thresholds" }, thresholds: { steps: [{ color: "green", value: 0 }, { color: "yellow", value: 5 }, { color: "red", value: 10 }] } } } },
                { title: "Idle Workers", type: "stat", gridPos: { h: 4, w: 6, x: 18, y: 0 }, targets: [{ expr: `sum(apache_workers{state="idle"})`, legendFormat: "Idle" }], fieldConfig: { defaults: { color: { mode: "thresholds" }, thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 2 }, { color: "green", value: 5 }] } } } },
                { title: "Apache CPU Load", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 8 }, targets: [{ expr: "apache_cpuload", legendFormat: "CPU Load - {{pod}}" }] },
                { title: "Pod Memory Usage", type: "timeseries", gridPos: { h: 8, w: 12, x: 12, y: 8 }, targets: [{ expr: `sum by (pod) (container_memory_working_set_bytes{namespace="guestbook-frontend", pod=~"frontend-.*"})`, legendFormat: "{{pod}}" }], fieldConfig: { defaults: { unit: "bytes" } } },
                { title: "Frontend Replicas Available", type: "stat", gridPos: { h: 4, w: 6, x: 12, y: 16 }, targets: [{ expr: `kube_deployment_status_replicas_available{namespace="guestbook-frontend"}`, legendFormat: "Available" }], fieldConfig: { defaults: { color: { mode: "thresholds" }, thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 1 }, { color: "green", value: 2 }] } } } },
            ],
        }),
    },
}, { dependsOn: prometheusStack });

const k8sPodsDashboard = new k8s.core.v1.ConfigMap("kubernetes-pods-dashboard", {
    metadata: { name: "kubernetes-pods-dashboard", namespace: "monitoring", labels: dashboardLabels },
    data: {
        "kubernetes-pods.json": JSON.stringify({
            title: "Kubernetes — Pod Resources",
            uid: "k8s-pods",
            refresh: "30s",
            schemaVersion: 38,
            version: 1,
            panels: [
                { title: "Pod CPU — guestbook-frontend", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 0 }, targets: [{ expr: `rate(container_cpu_usage_seconds_total{namespace="guestbook-frontend", pod=~"frontend-.*"}[5m])`, legendFormat: "{{pod}} / {{container}}" }] },
                { title: "Pod CPU — guestbook-backend", type: "timeseries", gridPos: { h: 8, w: 12, x: 12, y: 0 }, targets: [{ expr: `rate(container_cpu_usage_seconds_total{namespace="guestbook-backend", pod=~"redis-.*"}[5m])`, legendFormat: "{{pod}} / {{container}}" }] },
                { title: "Pod Memory — guestbook-frontend", type: "timeseries", gridPos: { h: 8, w: 12, x: 0, y: 8 }, targets: [{ expr: `container_memory_working_set_bytes{namespace="guestbook-frontend", pod=~"frontend-.*"}`, legendFormat: "{{pod}} / {{container}}" }], fieldConfig: { defaults: { unit: "bytes" } } },
                { title: "Pod Memory — guestbook-backend", type: "timeseries", gridPos: { h: 8, w: 12, x: 12, y: 8 }, targets: [{ expr: `container_memory_working_set_bytes{namespace="guestbook-backend", pod=~"redis-.*"}`, legendFormat: "{{pod}} / {{container}}" }], fieldConfig: { defaults: { unit: "bytes" } } },
                { title: "Pod Restarts", type: "timeseries", gridPos: { h: 8, w: 24, x: 0, y: 16 }, targets: [{ expr: `kube_pod_container_status_restarts_total{namespace=~"guestbook-frontend|guestbook-backend"}`, legendFormat: "{{namespace}} / {{pod}}" }] },
            ],
        }),
    },
}, { dependsOn: prometheusStack });

// ============================================================
// SECURITY — LimitRanges (inject defaults for pods without explicit limits)
// Must be created BEFORE ResourceQuotas so all pods get defaults
// ============================================================
const backendLimitRange = new k8s.core.v1.LimitRange("backend-limitrange", {
    metadata: { name: "backend-limits", namespace: "guestbook-backend" },
    spec: {
        limits: [{
            type: "Container",
            default: { cpu: "200m", memory: "200Mi" },
            defaultRequest: { cpu: "100m", memory: "100Mi" },
            max: { cpu: "500m", memory: "512Mi" },
            min: { cpu: "50m", memory: "50Mi" },
        }],
    },
}, { dependsOn: backendNs });

const frontendLimitRange = new k8s.core.v1.LimitRange("frontend-limitrange", {
    metadata: { name: "frontend-limits", namespace: "guestbook-frontend" },
    spec: {
        limits: [{
            type: "Container",
            default: { cpu: "200m", memory: "200Mi" },
            defaultRequest: { cpu: "100m", memory: "100Mi" },
            max: { cpu: "500m", memory: "512Mi" },
            min: { cpu: "50m", memory: "50Mi" },
        }],
    },
}, { dependsOn: frontendNs });

const monitoringLimitRange = new k8s.core.v1.LimitRange("monitoring-limitrange", {
    metadata: { name: "monitoring-limits", namespace: "monitoring" },
    spec: {
        limits: [{
            type: "Container",
            default: { cpu: "200m", memory: "256Mi" },
            defaultRequest: { cpu: "100m", memory: "128Mi" },
            max: { cpu: "1", memory: "1Gi" },
            min: { cpu: "10m", memory: "32Mi" },
        }],
    },
}, { dependsOn: monitoringNs });

// ============================================================
// SECURITY — Secrets
// ============================================================
const grafanaSecret = new k8s.core.v1.Secret("grafana-credentials", {
    metadata: { name: "grafana-credentials", namespace: "monitoring" },
    type: "Opaque",
    stringData: { "admin-user": "admin", "admin-password": grafanaPassword },
}, { dependsOn: prometheusStack });

const redisSecret = new k8s.core.v1.Secret("redis-credentials", {
    metadata: { name: "redis-credentials", namespace: "guestbook-backend" },
    type: "Opaque",
    stringData: { "redis-password": "r3d1s-s3cur3-p4ss" },
}, { dependsOn: backendNs });

// ============================================================
// SECURITY — ResourceQuotas
// ============================================================
const backendQuota = new k8s.core.v1.ResourceQuota("backend-quota", {
    metadata: { name: "backend-quota", namespace: "guestbook-backend" },
    spec: { hard: { "requests.cpu": "1", "requests.memory": "1Gi", "limits.cpu": "2", "limits.memory": "2Gi", "pods": "10" } },
}, { dependsOn: backendLimitRange });

const frontendQuota = new k8s.core.v1.ResourceQuota("frontend-quota", {
    metadata: { name: "frontend-quota", namespace: "guestbook-frontend" },
    spec: { hard: { "requests.cpu": "1", "requests.memory": "1Gi", "limits.cpu": "2", "limits.memory": "2Gi", "pods": "10" } },
}, { dependsOn: frontendLimitRange });

const monitoringQuota = new k8s.core.v1.ResourceQuota("monitoring-quota", {
    metadata: { name: "monitoring-quota", namespace: "monitoring" },
    spec: { hard: { "requests.cpu": "2", "requests.memory": "4Gi", "limits.cpu": "4", "limits.memory": "8Gi", "pods": "20" } },
}, { dependsOn: monitoringLimitRange });

// ============================================================
// SECURITY — PodDisruptionBudgets
// ============================================================
const redisLeaderPdb = new k8s.policy.v1.PodDisruptionBudget("redis-leader-pdb", {
    metadata: { name: "redis-leader-pdb", namespace: "guestbook-backend" },
    spec: { minAvailable: 1, selector: { matchLabels: { app: "redis", role: "leader" } } },
}, { dependsOn: redisLeaderDeployment });

const redisFollowerPdb = new k8s.policy.v1.PodDisruptionBudget("redis-follower-pdb", {
    metadata: { name: "redis-follower-pdb", namespace: "guestbook-backend" },
    spec: { minAvailable: 1, selector: { matchLabels: { app: "redis", role: "follower" } } },
}, { dependsOn: redisFollowerDeployment });

const frontendPdb = new k8s.policy.v1.PodDisruptionBudget("frontend-pdb", {
    metadata: { name: "frontend-pdb", namespace: "guestbook-frontend" },
    spec: { minAvailable: 1, selector: { matchLabels: { app: "guestbook", tier: "frontend" } } },
}, { dependsOn: frontendDeployment });

// ============================================================
// SECURITY — NetworkPolicies
// ============================================================
const backendDenyAll = new k8s.networking.v1.NetworkPolicy("backend-deny-all", {
    metadata: { name: "default-deny-ingress", namespace: "guestbook-backend" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
}, { dependsOn: backendNs });

const allowFrontendToRedis = new k8s.networking.v1.NetworkPolicy("allow-frontend-to-redis", {
    metadata: { name: "allow-frontend-to-redis", namespace: "guestbook-backend" },
    spec: {
        podSelector: { matchLabels: { app: "redis" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "guestbook-frontend" } } }], ports: [{ protocol: "TCP", port: 6379 }] }],
    },
}, { dependsOn: backendNs });

const allowMonitoringToBackend = new k8s.networking.v1.NetworkPolicy("allow-monitoring-to-backend", {
    metadata: { name: "allow-monitoring-to-backend", namespace: "guestbook-backend" },
    spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } } }] }],
    },
}, { dependsOn: backendNs });

const frontendDenyAll = new k8s.networking.v1.NetworkPolicy("frontend-deny-all", {
    metadata: { name: "default-deny-ingress", namespace: "guestbook-frontend" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
}, { dependsOn: frontendNs });

const allowIngressToFrontend = new k8s.networking.v1.NetworkPolicy("allow-ingress-to-frontend", {
    metadata: { name: "allow-ingress-to-frontend", namespace: "guestbook-frontend" },
    spec: {
        podSelector: { matchLabels: { app: "guestbook" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }], ports: [{ protocol: "TCP", port: 80 }] }],
    },
}, { dependsOn: frontendNs });

const allowMonitoringToFrontend = new k8s.networking.v1.NetworkPolicy("allow-monitoring-to-frontend", {
    metadata: { name: "allow-monitoring-to-frontend", namespace: "guestbook-frontend" },
    spec: {
        podSelector: { matchLabels: { app: "guestbook" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } } }], ports: [{ protocol: "TCP", port: 9117 }] }],
    },
}, { dependsOn: frontendNs });

const monitoringDenyAll = new k8s.networking.v1.NetworkPolicy("monitoring-deny-all", {
    metadata: { name: "default-deny-ingress", namespace: "monitoring" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
}, { dependsOn: prometheusStack });

const allowIngressToGrafana = new k8s.networking.v1.NetworkPolicy("allow-ingress-to-grafana", {
    metadata: { name: "allow-ingress-to-grafana", namespace: "monitoring" },
    spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "grafana" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }], ports: [{ protocol: "TCP", port: 3000 }] }],
    },
}, { dependsOn: prometheusStack });

const allowIntraMonitoring = new k8s.networking.v1.NetworkPolicy("allow-intra-monitoring", {
    metadata: { name: "allow-intra-monitoring", namespace: "monitoring" },
    spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } } }] }],
    },
}, { dependsOn: prometheusStack });

// ============================================================
// STACK OUTPUTS
// ============================================================
export const frontendUrl = "http://guestbook.local  (after adding to /etc/hosts)  OR  kubectl port-forward svc/frontend 8080:80 -n guestbook-frontend";
export const grafanaUrl = "http://grafana.local  (after adding to /etc/hosts)  OR  kubectl port-forward svc/prometheus-grafana 3000:80 -n monitoring";
export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = grafanaPassword;
export const addHostsCommand = "echo '192.168.49.5 guestbook.local grafana.local' | sudo tee -a /etc/hosts";
export const verifyScrapingCommand = "kubectl port-forward svc/prometheus-prometheus 9090:9090 -n monitoring  →  http://localhost:9090/targets  →  frontend-monitor 2/2 UP";
export const verifyMetricsCommand = "POD=$(kubectl get pods -n guestbook-frontend -o jsonpath='{.items[0].metadata.name}') && kubectl exec $POD -n guestbook-frontend -c php-redis -- curl -s http://localhost:9117/metrics | head -20";

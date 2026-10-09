# Blue-Green Deployment Master Guide (Version 2.0)

A comprehensive, battle-tested operational guide for deploying, managing, and practicing **Blue-Green Deployments** on **AWS EC2 (K3s)** using **GitHub Actions**, **Docker Hub**, and **Kubernetes Gateway API (Envoy Gateway)**.

---

## Table of Contents
1. [Core Architectural Concept](#1-core-architectural-concept)
2. [The "Flip-Flop" Release Lifecycle](#2-the-flip-flop-release-lifecycle)
3. [Required Credentials & Secrets](#3-required-credentials--secrets)
4. [EC2 & K3s One-Time Cluster Setup](#4-ec2--k3s-one-time-cluster-setup)
5. [Project & Manifest Architecture](#5-project--manifest-architecture)
6. [Step-by-Step Deployment Runbook](#6-step-by-step-deployment-runbook)
7. [How to Check Who is at 100% and Who is at 0%](#7-how-to-check-who-is-at-100-and-who-is-at-0)
8. [Real-World Issues Encountered & Solutions](#8-real-world-issues-encountered--solutions)

---

## 1. Core Architectural Concept

### What is Blue-Green Deployment?
In traditional rolling deployments, old pods are killed and replaced incrementally. If an update has bugs, users experience errors during the rollout, and rolling back takes several minutes.

**Blue-Green Deployment** eliminates this risk by running **two identical production environments**:
- **Blue**: One version of the application.
- **Green**: The alternate version of the application.
- **Kubernetes Gateway API (`HTTPRoute`)**: Sits in front as an intelligent traffic router.

```
                               ┌────────────────────────────────────────────────┐
                               │           AWS EC2 (K3s Node :80)              │
                               │        Kubernetes Gateway API (Envoy)          │
                               └───────────────────────┬────────────────────────┘
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
          Public Users (100% Traffic)                             Testers Header (X-Version: green)
                           ▼                                                       ▼
             ┌───────────────────────────┐                           ┌───────────────────────────┐
             │     BLUE ENVIRONMENT      │                           │     GREEN ENVIRONMENT     │
             │   (Version 1.0 - Active)  │                           │    (Version 2.0 - Idle)   │
             │                           │                           │                           │
             │  Service: blue-svc:80     │                           │  Service: green-svc:80    │
             │  Pods: [Pod-B1] [Pod-B2]  │                           │  Pods: [Pod-G1] [Pod-G2]  │
             └───────────────────────────┘                           └───────────────────────────┘
```

---

## 2. The "Flip-Flop" Release Lifecycle

Blue-Green is an **alternating cycle**. You never overwrite the active environment while users are on it; you always deploy to the environment currently receiving **0% traffic**:

| Release Cycle | Currently Active (100% Public) | Currently Idle (0% Public) | Action Taken |
| :--- | :--- | :--- | :--- |
| **Release 1** (v1.0) | **Blue** (v1.0) | **Green** (Empty / Standby) | Deploy Blue, switch traffic to Blue. |
| **Release 2** (v2.0) | **Blue** (v1.0 is live!) | Deploy to **Green** (v2.0) | Test Green via `X-Version: green` ➔ Switch traffic to Green. |
| **Release 3** (v3.0) | **Green** (v2.0 is live!) | Deploy to **Blue** (v3.0) | Test Blue via `X-Version: blue` ➔ Switch traffic to Blue. |
| **Release 4** (v4.0) | **Blue** (v3.0 is live!) | Deploy to **Green** (v4.0) | Test Green via `X-Version: green` ➔ Switch traffic to Green. |

---

## 3. Required Credentials & Secrets

Store these 5 secrets in **GitHub Repo** ➔ **Settings** ➔ **Secrets and variables** ➔ **Actions**:

| Secret Name | Description | Example / Location |
| :--- | :--- | :--- |
| `DOCKERHUB_USERNAME` | Your Docker Hub account username | `kalees64` |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token | Docker Hub ➔ Account Settings ➔ Security ➔ Personal Access Token |
| `EC2_HOST` | Public IP or Public DNS of your EC2 instance | `54.210.xx.xx` |
| `EC2_USER` | SSH user | `ubuntu` (or `ec2-user`) |
| `EC2_SSH_KEY` | Private SSH Key (`.pem` file contents) | Starts with `-----BEGIN OPENSSH PRIVATE KEY-----` |

> [!IMPORTANT]
> Never commit private keys or API tokens into git or share them in chat.

---

## 4. EC2 & K3s One-Time Cluster Setup

Execute these steps on your EC2 instance via SSH before launching the CI/CD pipeline:

### Step 4.1: Grant Kubeconfig Permissions to `ubuntu`
By default, `/etc/rancher/k3s/k3s.yaml` is only readable by `root`. Configure non-root user access:
```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
export KUBECONFIG=~/.kube/config
```

### Step 4.2: Disable Built-in Traefik to Free Port 80
K3s installs Traefik by default, which occupies Port 80. Remove it so Envoy Gateway can own Port 80:
```bash
sudo kubectl -n kube-system scale deployment traefik --replicas=0
sudo kubectl -n kube-system delete svc traefik
```

### Step 4.3: Install Kubernetes Gateway API (Experimental CRDs)
Envoy Gateway requires the **experimental** CRD channel (including `TLSRoute` and `BackendTLSPolicy`):
```bash
sudo kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```

### Step 4.4: Install Envoy Gateway (Helm & Pure Kubectl Fallback)

#### Option A: Install via Helm (Standard)
1. **If Helm is not installed**, install it in 10 seconds:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
   helm version
   ```
2. **Install Envoy Gateway using Helm**:
   ```bash
   helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.1.0 -n envoy-gateway-system --create-namespace
   ```

#### Option B: Fallback (No Helm Required - Pure `kubectl`)
If Helm is not installed, fails, or cannot pull from the OCI registry, install Envoy Gateway directly using the official standalone Kubernetes manifest:
```bash
sudo kubectl apply -f https://github.com/envoyproxy/gateway/releases/download/v1.1.0/install.yaml
```

### Step 4.5: Ensure AWS Security Group Port 80 is Open
In AWS EC2 Console ➔ **Security Groups** ➔ Inbound Rules ➔ Add Rule: **HTTP (Port 80)** from `0.0.0.0/0`.

---

## 5. Project & Manifest Architecture

```
├── .github/workflows/
│   └── deploy.yml                   # CI/CD pipeline with scp-action & traffic actions
├── k8s/
│   ├── namespace.yaml               # 'bluegreen' namespace definition
│   ├── gateway/
│   │   ├── gatewayclass.yaml        # Envoy GatewayClass ('eg')
│   │   ├── gateway.yaml             # Port 80 Gateway instance
│   │   ├── httproute-blue.yaml      # Blue 100%, Green 0% (Tester header -> Green)
│   │   └── httproute-green.yaml     # Green 100%, Blue 0% (Tester header -> Blue)
│   ├── blue/
│   │   ├── deployment.yaml          # Blue deployment (replicas: 2)
│   │   └── service.yaml             # ClusterIP service 'bluegreen-blue-svc'
│   └── green/
│       ├── deployment.yaml          # Green deployment (replicas: 2)
│       └── service.yaml             # ClusterIP service 'bluegreen-green-svc'
├── Dockerfile                       # Multi-stage production build (Node 20 + Nginx)
├── nginx.conf                       # Single Page Application fallback & gzip
└── DEPLOYMENT_GUIDE_v2.0.md
```

---

## 6. Step-by-Step Deployment Runbook

### Scenario A: Initial Deployment (Deploying Blue v1.0)
1. Go to GitHub Actions ➔ **Blue-Green CI/CD Pipeline** ➔ **Run workflow**.
2. Select:
   - `target_action`: **`deploy-blue`**
   - `image_tag`: **`v1.0`**
3. The pipeline builds the image, copies manifests to EC2, and applies Blue pods.
4. If traffic is not yet directed to Blue, run workflow with:
   - `target_action`: **`switch-traffic-to-blue`**
5. Verify in browser: `http://<EC2-PUBLIC-IP>` loads **BlueGreen v1.0**.

---

### Scenario B: Releasing New Changes (Deploying Green v2.0)
1. You make changes to the app (e.g. adding the `±20` button in `src/App.jsx`).
2. Commit and push your code:
   ```bash
   git add .
   git commit -m "feat: add 20+ button for release v2.0"
   git push origin main
   ```
3. Go to GitHub Actions ➔ **Run workflow**:
   - `target_action`: **`deploy-green`**
   - `image_tag`: **`v2.0`**
4. **Outcome**: Green pods are updated in K3s. **Public traffic is untouched and still sees Blue v1.0!**

---

### Scenario C: Testing Green Live in Production
Before switching public traffic, verify Green safely:

- **Option 1: Using curl with header**:
  ```bash
  curl -i -H "X-Version: green" http://<EC2-PUBLIC-IP>/
  ```
- **Option 2: Using Browser Extension (ModHeader)**:
  1. Install ModHeader.
  2. Add Request Header: `X-Version` = `green`.
  3. Visit `http://<EC2-PUBLIC-IP>`. You will see **v2.0 (with the ±20 button)**.
  4. Any user without this header continues to see **v1.0**.

---

### Scenario D: Zero-Downtime Cutover to Green
Once verified:
1. Go to GitHub Actions ➔ **Run workflow**:
   - `target_action`: **`switch-traffic-to-green`**
2. **Outcome**: The Gateway flips weights to:
   - `bluegreen-green-svc`: **100%**
   - `bluegreen-blue-svc`: **0%**
3. All public visitors now see **v2.0** instantly with zero dropped connections.

---

### Scenario E: Emergency Rollback
If a bug occurs in production:
1. Go to GitHub Actions ➔ **Run workflow**:
   - `target_action`: **`switch-traffic-to-blue`**
2. **Outcome**: Traffic shifts back to Blue (**100%**) in under 1 second.

---

## 7. How to Check Who is at 100% and Who is at 0%

When a new developer joins the project, how do they know which environment is live?

### Method 1: Check GitHub Actions Run Logs (Automatic)
Every workflow execution logs the active routing state:
```text
================ Current Routing State ================
Backend: bluegreen-blue-svc  | Weight: 100%
Backend: bluegreen-green-svc | Weight: 0%
========================================================
```

### Method 2: One-Line CLI Command on EC2
```bash
sudo kubectl get httproute bluegreen-route -n bluegreen -o jsonpath='{range .spec.rules[-1].backendRefs[*]}{.name}{": "}{.weight}{"%\n"}{end}'
```
**Output**:
- `bluegreen-blue-svc: 100%` ➔ **Blue is Live** (Deploy next changes to Green).
- `bluegreen-green-svc: 100%` ➔ **Green is Live** (Deploy next changes to Blue).

### Method 3: In Portainer Web UI
1. Navigate to **Cluster** ➔ **Namespaces** ➔ **`bluegreen`**.
2. Open **Routes** ➔ `bluegreen-route`.
3. View the backend weights.

---

## 8. Real-World Issues Encountered & Solutions

### Issue 1: K3s Kubeconfig Permission Denied
- **Error**: `error loading config file "/etc/rancher/k3s/k3s.yaml": open /etc/rancher/k3s/k3s.yaml: permission denied`
- **Root Cause**: K3s sets `/etc/rancher/k3s/k3s.yaml` to permissions `0600 root:root`. The SSH user (`ubuntu`) cannot read it.
- **Fix**: Copied the config to `~/.kube/config` and chowned to `ubuntu:ubuntu`. Added automatic detection in `.github/workflows/deploy.yml`.

---

### Issue 2: Bash Heredoc Indentation Error in GitHub Actions
- **Error**: `bash: line 201: warning: here-document at line 35 delimited by end-of-file (wanted 'EOF')` / `syntax error: unexpected end of file`
- **Root Cause**: YAML requires indenting text inside `script: |`. However, Bash requires `EOF` to be at column 0 with zero spaces. Indenting `EOF` caused Bash to fail finding the delimiter.
- **Fix**: Replaced fragile bash heredocs with `appleboy/scp-action@v0.1.7` to synchronize the `k8s/` directory directly to EC2, followed by clean, single-line `kubectl apply` commands.

---

### Issue 3: Traefik Hijacking Port 80 (404 Error on IP)
- **Error**: Accessing `http://<EC2-IP>` returned `404 page not found`.
- **Root Cause**: K3s deploys Traefik by default, binding Port 80 on the host. When accessing the IP, requests hit Traefik instead of Envoy Gateway.
- **Fix**: Scaled down and deleted the Traefik service:
  ```bash
  sudo kubectl -n kube-system scale deployment traefik --replicas=0
  sudo kubectl -n kube-system delete svc traefik
  ```

---

### Issue 4: Gateway Stuck in "Waiting for controller"
- **Error**: `kubectl get gatewayclass` returned `No resources found`. Gateway condition was `Reason: Pending, Message: Waiting for controller`.
- **Root Cause**: The Gateway specified `gatewayClassName: eg`, but no `GatewayClass` resource existed in the cluster.
- **Fix**: Created [`k8s/gateway/gatewayclass.yaml`](file:///d:/Code/BlueGreen/k8s/gateway/gatewayclass.yaml) linking controller `gateway.envoyproxy.io/gatewayclass-controller`.

---

### Issue 5: Envoy Gateway CrashLoopBackOff (`TLSRoute` Missing)
- **Error**: `Error: failed to create provider Kubernetes: failed to create gatewayapi controller: no matches for kind "TLSRoute" in version "gateway.networking.k8s.io/v1alpha2"`
- **Root Cause**: Envoy Gateway implements TLS and TCP routing and mandates the **experimental** Gateway API CRD channel. The standard CRDs (`standard-install.yaml`) omitted `TLSRoute`.
- **Fix**: Applied `https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml`.

---

### Issue 6: CRD Storage Version Conflict During Downgrade
- **Error**: `CustomResourceDefinition... "tcproutes...": status.storedVersions[0]: Invalid value: "v1": missing from spec.versions`
- **Root Cause**: An existing CRD definition stored version `v1`. Kubernetes blocked applying `v1.1.0` (which had `v1alpha2`) to prevent data loss.
- **Fix**: Safely deleted the empty conflicting CRDs and re-applied cleanly:
  ```bash
  sudo kubectl delete crd tcproutes.gateway.networking.k8s.io tlsroutes.gateway.networking.k8s.io udproutes.gateway.networking.k8s.io backendtlspolicies.gateway.networking.k8s.io backendlbpolicies.gateway.networking.k8s.io
  sudo kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
  sudo kubectl rollout restart deployment envoy-gateway -n envoy-gateway-system
  ```

---

### Issue 7: "No resources found in default namespace"
- **Confusion**: Running `kubectl get pods` returned no resources.
- **Explanation**: Kubernetes isolates resources by namespace. All Blue-Green deployments and services live in the **`bluegreen`** namespace.
- **Fix**: Always specify `-n bluegreen` or use `-A`:
  ```bash
  sudo kubectl get pods -n bluegreen
  ```

---

### Issue 8: EC2 Docker Image Caching
- **Problem**: Re-pushing an updated image with the same tag (`v1.0`) did not reflect changes on the server.
- **Root Cause**: `imagePullPolicy: IfNotPresent` told K3s to reuse its cached local copy instead of pulling the updated image from Docker Hub.
- **Fix**: Use distinct version tags (`v1.0`, `v2.0`) for every release, and trigger `kubectl rollout restart deployment/<name> -n bluegreen` during CI/CD.

---

### Issue 9: Helm Not Installed or Helm OCI Registry Fails
- **Error**: `helm: command not found` or `Error: failed to fetch oci registry: ...`
- **Root Cause**: EC2 instances do not include Helm by default, or an older Helm version lacks OCI artifact support.
- **Fix 1 (Install Helm)**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ```
- **Fix 2 (Direct Kubectl Fallback - No Helm Needed)**:
  If Helm cannot be installed or you prefer not to use package managers, apply the official standalone Envoy Gateway manifest directly:
  ```bash
  sudo kubectl apply -f https://github.com/envoyproxy/gateway/releases/download/v1.1.0/install.yaml
  ```

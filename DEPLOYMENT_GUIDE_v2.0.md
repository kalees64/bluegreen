# Blue-Green Deployment Master Guide (Version 2.0)

A comprehensive, battle-tested operational guide for deploying, managing, and practicing **Blue-Green Deployments** on **AWS EC2 (K3s)** using **GitHub Actions**, **Docker Hub**, and **Kubernetes Gateway API (Envoy Gateway)**.

---

## Table of Contents
1. [Kubernetes 101: Fundamentals & Command Cheat Sheet](#1-kubernetes-101-fundamentals--command-cheat-sheet)
2. [New Developer Guidelines & Golden Rules](#2-new-developer-guidelines--golden-rules)
3. [Core Architectural Concept](#3-core-architectural-concept)
4. [The "Flip-Flop" Release Lifecycle](#4-the-flip-flop-release-lifecycle)
5. [Avoiding "Ghost Rollbacks" & Version Desync](#5-avoiding-ghost-rollbacks--version-desync)
6. [Pre-Commit & Pre-Push Quality Gates (.githooks)](#6-pre-commit--pre-push-quality-gates-githooks)
7. [Required Credentials & Secrets](#7-required-credentials--secrets)
8. [EC2 & K3s One-Time Cluster Setup](#8-ec2--k3s-one-time-cluster-setup)
9. [Project & Manifest Architecture](#9-project--manifest-architecture)
10. [Step-by-Step Deployment Runbook](#10-step-by-step-deployment-runbook)
11. [How to Check Who is at 100% and Who is at 0%](#11-how-to-check-who-is-at-100-and-who-is-at-0)
12. [Real-World Issues Encountered & Solutions](#12-real-world-issues-encountered--solutions)

---

## 1. Kubernetes 101: Fundamentals & Command Cheat Sheet

If you are new to Kubernetes (often abbreviated as **K8s**), think of it as an **automatic orchestra conductor** for Docker containers. Instead of manually starting containers on servers, you describe your desired state (e.g., *"I want 2 copies of my React app running on port 80"*), and Kubernetes continuously reconciles the cluster to ensure that state exists, automatically restarting dead containers and load-balancing traffic.

### 1.1 Kubernetes Architecture at a Glance

A Kubernetes cluster is divided into two primary planes:
1. **Control Plane** (The Brain):
   - **API Server (`kube-apiserver`)**: The central entry point that receives commands from `kubectl` and CI/CD pipelines.
   - **etcd**: The distributed key-value database holding the complete cluster state and configuration.
   - **Scheduler (`kube-scheduler`)**: Selects which worker node should run newly created pods based on resources.
   - **Controller Manager**: Watches the cluster and reconciles differences between actual state and desired state (self-healing).
2. **Worker Nodes** (The Muscle):
   - **Kubelet**: The node-level agent that communicates with the control plane and manages local containers.
   - **Container Runtime (`containerd`)**: Pulls images from Docker Hub and executes the physical containers.
   - **Kube-proxy / Gateway**: Directs external and internal network traffic into the appropriate pods.

*(In our EC2 setup, we run **K3s** — a lightweight, certified Kubernetes distribution that runs both the Control Plane and Worker components in a single, resource-efficient binary).*

---

### 1.2 Core Kubernetes Objects Explained Simply

| Concept | What It Is (Simple Analogy) | Role in This Project |
| :--- | :--- | :--- |
| **Pod** | The smallest deployable unit. Think of a pod as a **room** housing one container (or tightly coupled sidecars). Pods are ephemeral and receive dynamic IP addresses. | `bluegreen-blue-xxx` and `bluegreen-green-xxx` pods running Nginx + React. |
| **Deployment** | A controller that manages a set of identical pods. Handles scaling, rolling updates, self-healing, and rollbacks. | `bluegreen-blue` and `bluegreen-green` deployments (each configured with `replicas: 2`). |
| **ReplicaSet** | The low-level manager maintained by the Deployment to guarantee an exact number of healthy pods are always running. | Maintained automatically behind the scenes by each Deployment. |
| **Service (`ClusterIP`)** | A stable **internal DNS name and virtual IP** that load-balances traffic across dynamic pod IPs. | `bluegreen-blue-svc:80` and `bluegreen-green-svc:80`. |
| **Namespace** | A **virtual workspace** inside the cluster to partition resources and avoid naming conflicts. | All resources are isolated in the **`bluegreen`** namespace (keeping them distinct from `kube-system`). |
| **Gateway API** | The modern Kubernetes traffic routing standard (successor to legacy Ingress). Allows native traffic splitting by weight and HTTP header routing. | Managed by **Envoy Gateway**; routes public port 80 traffic between Blue and Green. |
| **HTTPRoute** | A routing rule attached to a Gateway defining hostnames, paths, header filters, and backend services with percentage weights. | `httproute-blue.yaml` and `httproute-green.yaml`. |

---

### 1.3 Pod Lifecycle & Common Statuses (Beginner Diagnostic Guide)

When running `sudo kubectl get pods -n bluegreen`, inspect the `STATUS` column:

| Status | What It Means | Beginner Action / Fix |
| :--- | :--- | :--- |
| `Pending` | Pod is accepted by K8s but waiting for resources, scheduling, or disk allocation. | Check cluster resources or run `kubectl describe pod <name>` to view scheduling events. |
| `ContainerCreating` | Image is actively downloading or volumes are mounting. | Wait 10-30 seconds. If stuck, check Docker Hub credentials or network connectivity. |
| `Running` | Pod is healthy, container is active, and serving requests normally. | Everything is running perfectly. |
| `CrashLoopBackOff` | Container started, crashed immediately, was restarted by K8s, and crashed again. | Run `kubectl logs <pod-name> --previous` or `kubectl describe pod <pod-name>` to inspect fatal errors. |
| `ImagePullBackOff` / `ErrImagePull` | Kubernetes cannot download the image from Docker Hub (typo in image name/tag, private repo auth issue). | Verify the image name and tag on Docker Hub; check `deployment.yaml`. |
| `Terminating` | Old pod is completing active connections before shutting down during a rollout. | Normal during updates; terminates within 30 seconds. |

---

### 1.4 Essential `kubectl` Beginner Command Reference

> [!TIP]
> **Pro-Tip: Set the Default Namespace Once**  
> Run this command on your EC2 terminal to avoid typing `-n bluegreen` on every single command:
> ```bash
> sudo kubectl config set-context --current --namespace=bluegreen
> ```
> Now, `kubectl get pods` will automatically target the `bluegreen` namespace!

#### 1. Inspecting Resources
```bash
# List all pods with their assigned IP addresses and host nodes
sudo kubectl get pods -n bluegreen -o wide

# List all deployments and their replica status
sudo kubectl get deployments -n bluegreen

# List all internal services and their ClusterIP addresses
sudo kubectl get svc -n bluegreen

# List all resources (pods, deployments, services) at once
sudo kubectl get all -n bluegreen

# Watch pod status changes live in real-time (press Ctrl+C to exit)
sudo kubectl get pods -n bluegreen -w
```

#### 2. Diagnosing & Debugging Problems
```bash
# Deep inspection: events, health checks, image tag, and lifecycle details
sudo kubectl describe pod <pod-name> -n bluegreen

# Stream real-time logs from a specific pod
sudo kubectl logs -f <pod-name> -n bluegreen

# View the last 50 log lines across all app pods simultaneously
sudo kubectl logs -l app=bluegreen -n bluegreen --tail=50

# View logs from a crashed container (essential for CrashLoopBackOff)
sudo kubectl logs <pod-name> -n bluegreen --previous

# Open an interactive shell inside a running container to test files or curl
sudo kubectl exec -it <pod-name> -n bluegreen -- sh

# View cluster events in chronological order (great for debugging failures)
sudo kubectl get events -n bluegreen --sort-by='.metadata.creationTimestamp'
```

#### 3. Managing Deployments & Rollouts
```bash
# Restart all pods in a deployment (forces fresh image pull)
sudo kubectl rollout restart deployment/bluegreen-blue -n bluegreen
sudo kubectl rollout restart deployment/bluegreen-green -n bluegreen

# Monitor the real-time status of a deployment rollout
sudo kubectl rollout status deployment/bluegreen-blue -n bluegreen

# View deployment rollout history
sudo kubectl rollout history deployment/bluegreen-blue -n bluegreen

# Undo/Rollback a deployment to the previous revision
sudo kubectl rollout undo deployment/bluegreen-blue -n bluegreen
```

#### 4. Applying Manifests & Local Port-Forwarding
```bash
# Apply or update a manifest declaratively
sudo kubectl apply -f k8s/blue/deployment.yaml

# Temporarily forward a cluster service to a local port for testing
sudo kubectl port-forward svc/bluegreen-blue-svc 8080:80 -n bluegreen
# (Now visit http://localhost:8080 in curl or browser)
```

---

## 2. New Developer Guidelines & Golden Rules

Welcome to the team! Follow these operational rules to guarantee zero-downtime releases and prevent production accidents.

### 2.1 The 5 Golden Rules of Blue-Green Deployments

1. **Rule 1: Never Deploy Directly to the Active (100%) Environment**  
   Always check who is currently live. If Blue is receiving 100% of public traffic, **all new code must be deployed to Green**. Never overwrite the environment real users are currently browsing.
2. **Rule 2: Always Test with the `X-Version` Header Before Switching Traffic**  
   Envoy Gateway allows you to test the idle environment in production without affecting public users. Use ModHeader or `curl -H "X-Version: <color>"` to test thoroughly before triggering cutover.
3. **Rule 3: Single Source of Truth for Versioning (`package.json`)**  
   Never guess version tags. Bump `"version"` in `package.json` (e.g. `1.1.0` ➔ `1.2.0`). Git and Docker Hub tags will stay aligned.
4. **Rule 4: Avoid "Ghost Rollbacks" by Running Catch-Up Deployments**  
   After you cut over to Green (`v1.1`), the Blue environment is still on `v1.0`. Once Green is verified stable, run a catch-up deployment to update Blue to `v1.1`. This keeps your backup fresh and prevents configuration drift.
5. **Rule 5: Always Respect Pre-Commit and Pre-Push Quality Gates**  
   Never bypass Git hooks with `--no-verify`. If the linter or build fails on your laptop, it will fail on Docker Hub and break the deployment pipeline.

---

### 2.2 New Developer Decision Flowchart

```
                 [You write a new feature or bug fix]
                                  │
                                  ▼
                     Run Local Checks & Tests:
                   npm run lint && npm run build
                                  │
                                  ▼
                     Bump version in package.json
                     (e.g., v1.0.0 ➔ v1.1.0)
                                  │
                                  ▼
                         git commit & git push
                  (Git hooks validate code automatically)
                                  │
                                  ▼
                [Step 1: Check Current Routing State]
               Run on EC2 or check GitHub Actions log:
                 Who has 100%? (e.g., Blue is 100%)
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
       If Blue is 100% Active:          If Green is 100% Active:
       Target = deploy-green            Target = deploy-blue
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
              [Step 2: Trigger GitHub Actions Workflow]
              • target_action: deploy-green (or deploy-blue)
              • image_tag: v1.1
                                  │
                                  ▼
              [Step 3: Test Idle Environment Live]
              curl -H "X-Version: green" http://<EC2-IP>/
              (Verify new features while users see v1.0)
                                  │
                                  ▼
              [Step 4: Execute Zero-Downtime Cutover]
              • target_action: switch-traffic-to-green
              (Public traffic flips instantly to v1.1)
                                  │
                                  ▼
              [Step 5: Catch-Up / Sync Backup]
              Deploy v1.1 to Blue so both environments match!
```

---

### 2.3 Developer Dos and Don'ts

| DO | DON'T |
| :--- | :--- |
| **DO** check active routing weights before deploying. | **DON'T** deploy blindly without knowing whether Blue or Green is live. |
| **DO** verify the production build locally (`npm run build`) before pushing. | **DON'T** push broken syntax or use `git commit --no-verify`. |
| **DO** use the `X-Version` header to smoke-test new code on EC2. | **DON'T** switch traffic to public users without verifying the idle pods. |
| **DO** run a catch-up deployment to sync the idle environment after cutover. | **DON'T** leave the idle environment months behind on obsolete code. |
| **DO** trigger `switch-traffic-to-blue` (or green) if a critical bug appears. | **DON'T** panic or rewrite code directly on the production EC2 server. |
| **DO** keep secrets in GitHub Actions Secrets. | **DON'T** commit SSH keys, passwords, or tokens into Git repositories. |

---

## 3. Core Architectural Concept

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

## 4. The "Flip-Flop" Release Lifecycle

Blue-Green is an **alternating cycle**. You never overwrite the active environment while users are on it; you always deploy to the environment currently receiving **0% traffic**:

| Release Cycle | Currently Active (100% Public) | Currently Idle (0% Public) | Action Taken |
| :--- | :--- | :--- | :--- |
| **Release 1** (v1.0) | **Blue** (v1.0) | **Green** (Empty / Standby) | Deploy Blue, switch traffic to Blue. |
| **Release 2** (v2.0) | **Blue** (v1.0 is live!) | Deploy to **Green** (v2.0) | Test Green via `X-Version: green` ➔ Switch traffic to Green. |
| **Release 3** (v3.0) | **Green** (v2.0 is live!) | Deploy to **Blue** (v3.0) | Test Blue via `X-Version: blue` ➔ Switch traffic to Blue. |
| **Release 4** (v4.0) | **Blue** (v3.0 is live!) | Deploy to **Green** (v4.0) | Test Green via `X-Version: green` ➔ Switch traffic to Green. |

---

## 5. Avoiding "Ghost Rollbacks" & Version Desync

### Scenario: What Happens If Blue Remains on `v1.0` While Green is on `v1.1`?
Suppose you deployed `v1.1` to Green, tested it, and switched traffic to Green (Green is now 100% Active). 
However, `k8s/blue/deployment.yaml` in Git still hardcodes `image: kalees64/bluegreen:v1.0`.

#### The Risks:
1. **The "Ghost Rollback" Trap**:
   If another developer triggers `switch-traffic-to-blue`, traffic will flip back to the old `v1.0`! The features and bug fixes from `v1.1` will silently vanish from production.
2. **Configuration Drift (Git vs Cluster Desync)**:
   The YAML in your Git repository claims Blue is `v1.0`, but you might think it has the latest release. Git is no longer a reliable single source of truth.
3. **Wasted Idle Resources**:
   Blue is sitting idle with obsolete code that cannot safely serve backup traffic if Green crashes.

#### Prevention Guidelines:
- **Rule 1: Single Source of Truth**: Keep the version in `package.json` (e.g. `"version": "1.1.0"`). The CI/CD pipeline extracts this version automatically rather than developers manually guessing tags.
- **Rule 2: Dynamic Image Injection**: Do not hardcode fixed tags in `k8s/` manifests; let CI/CD inject `${IMAGE_TAG}` dynamically into the deployment manifest during deployment.
- **Rule 3: Post-Cutover Catch-Up Deployment**: After you cut over to Green (`v1.1`) and verify stability, trigger `deploy-blue` with `v1.1`. Both environments will then be synchronized at `v1.1`, ready for the next release (`v1.2`).

---

## 6. Pre-Commit & Pre-Push Quality Gates (.githooks)

To prevent broken code, lint failures, and syntax issues from ever reaching GitHub or Docker Hub, use lightweight, zero-dependency Git hooks.

### 5.1 What Runs at Each Stage?

| Hook | Speed | When It Runs | Checks Executed |
| :--- | :--- | :--- | :--- |
| **Pre-Commit** | < 1 second | Before `git commit` completes | • Fast linting with Oxlint (`npm run lint`)<br>• Syntax and JSON validation<br>• Blocks broken commits locally |
| **Pre-Push** | ~5-10 seconds | Before `git push` sends code to remote | • Full Vite production build (`npm run build`)<br>• Catches missing imports, JSX errors, and broken CSS<br>• Prevents breaking the GitHub Actions pipeline |

### 5.2 How to Set Up Shared `.githooks` Handily

We store hooks in the repository inside `.githooks/` so every developer shares the same standards:

1. **Configure Git to use the repo hooks directory**:
   ```bash
   git config core.hooksPath .githooks
   ```
2. **File: `.githooks/pre-commit`**:
   ```bash
   #!/bin/sh
   echo "🔍 Running pre-commit lint check..."
   npm run lint
   if [ $? -ne 0 ]; then
     echo "❌ Lint errors found! Please fix them before committing."
     exit 1
   fi
   echo "✅ Pre-commit check passed!"
   ```
3. **File: `.githooks/pre-push`**:
   ```bash
   #!/bin/sh
   echo "🚀 Running pre-push build validation..."
   npm run build
   if [ $? -ne 0 ]; then
     echo "❌ Build failed! Fix Vite build errors before pushing."
     exit 1
   fi
   echo "✅ Production build succeeded! Pushing to remote..."
   ```

---

## 7. Required Credentials & Secrets

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

## 8. EC2 & K3s One-Time Cluster Setup

Execute these steps on your EC2 instance via SSH before launching the CI/CD pipeline:

### Step 7.1: Grant Kubeconfig Permissions to `ubuntu`
By default, `/etc/rancher/k3s/k3s.yaml` is only readable by `root`. Configure non-root user access:
```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
export KUBECONFIG=~/.kube/config
```

### Step 7.2: Disable Built-in Traefik to Free Port 80
K3s installs Traefik by default, which occupies Port 80. Remove it so Envoy Gateway can own Port 80:
```bash
sudo kubectl -n kube-system scale deployment traefik --replicas=0
sudo kubectl -n kube-system delete svc traefik
```

### Step 7.3: Install Kubernetes Gateway API (Experimental CRDs)
Envoy Gateway requires the **experimental** CRD channel (including `TLSRoute` and `BackendTLSPolicy`):
```bash
sudo kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```

### Step 7.4: Install Envoy Gateway (Helm & Pure Kubectl Fallback)

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

### Step 7.5: Ensure AWS Security Group Port 80 is Open
In AWS EC2 Console ➔ **Security Groups** ➔ Inbound Rules ➔ Add Rule: **HTTP (Port 80)** from `0.0.0.0/0`.

---

## 9. Project & Manifest Architecture

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

## 10. Step-by-Step Deployment Runbook

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

## 11. How to Check Who is at 100% and Who is at 0%

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

## 12. Real-World Issues Encountered & Solutions

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

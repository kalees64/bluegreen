# Blue-Green Deployment Master Guide

This guide explains **Blue-Green Deployment** from theoretical principles to end-to-end hands-on execution on your AWS EC2 instance running **K3s**, **Portainer**, and **Kubernetes Gateway API**.

---

## 1. What is Blue-Green Deployment & How Does It Work?

### The Core Concept
In software deployments, downtime or broken releases can disrupt users. Traditional rolling deployments replace old pods with new ones gradually, which can result in:
- A mix of old and new versions running simultaneously.
- Slower rollbacks if the new version fails under live traffic.

**Blue-Green Deployment** solves this by maintaining **two identical production environments**:
- **Blue (Active / Current)**: Currently serving 100% of live user traffic (Version 1.0).
- **Green (Idle / Staging / Next)**: Hosts the new release (Version 2.0).

```
                      ┌──────────────────────────────────────┐
                      │     Kubernetes Gateway API           │
                      │  (Traffic Controller / Load Balancer)│
                      └──────────────────┬───────────────────┘
                                         │
              ┌──────────────────────────┴──────────────────────────┐
   Public Traffic (100%)                                Tester Traffic (Header: X-Version=green)
              ▼                                                     ▼
┌───────────────────────────┐                         ┌───────────────────────────┐
│     BLUE ENVIRONMENT      │                         │     GREEN ENVIRONMENT     │
│   (Version 1.0 - Active)  │                         │   (Version 2.0 - Staging) │
│                           │                         │                           │
│  Service: blue-svc:80     │                         │  Service: green-svc:80    │
│  Pods: [Pod-B1] [Pod-B2]  │                         │  Pods: [Pod-G1] [Pod-G2]  │
└───────────────────────────┘                         └───────────────────────────┘
```

### The Flow: From Your PC to EC2 K3s
1. **You write code on your PC** (e.g. updating the app to v2.0).
2. **You commit & push to GitHub**.
3. **GitHub Actions CI/CD triggers**:
   - Builds a production-ready, multi-stage Docker image with Nginx.
   - Pushes the tagged image (`kalees64/bluegreen:v1.0` or `v2.0`) to **Docker Hub**.
   - Connects securely via SSH to your **EC2 instance**.
4. **EC2 K3s Cluster executes deployment**:
   - Pulls the image from Docker Hub.
   - Launches the pods in the `bluegreen` namespace (visible inside your Portainer dashboard).
5. **Gateway API controls user routing**:
   - Routes public internet traffic to Blue.
   - Lets you test Green privately using a test HTTP header (`X-Version: green`).
   - On your command, shifts 100% traffic to Green instantly without dropping a single TCP connection.

---

## 2. Credentials & GitHub Secrets Needed

To automate this pipeline securely, configure the following **5 secrets** in your GitHub repository:
👉 Go to **GitHub Repository** ➔ **Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**:

| Secret Name | Description | Example / Where to find |
| :--- | :--- | :--- |
| `DOCKERHUB_USERNAME` | Your Docker Hub account username | `kalees64` |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token | Docker Hub ➔ Account Settings ➔ Security ➔ New Access Token (Read & Write) |
| `EC2_HOST` | Public IP or DNS of your AWS EC2 instance | `54.210.xx.xx` |
| `EC2_USER` | SSH username for your EC2 instance | Usually `ubuntu` (or `ec2-user`) |
| `EC2_SSH_KEY` | Private SSH key (`.pem`) used to log in | The complete content of your `.pem` key file (starts with `-----BEGIN OPENSSH PRIVATE KEY-----`) |

> [!IMPORTANT]
> **Security Notice**: Never paste `DOCKERHUB_TOKEN` or `EC2_SSH_KEY` directly into public chats. Keep them strictly in GitHub Repository Secrets.

---

## 3. Step 1 to Last: Complete Step-by-Step Execution

### Step 1: EC2 One-Time Setup (Gateway API & Envoy Gateway)
Log into your EC2 terminal via SSH and verify K3s and Gateway API:

1. **Verify K3s is active**:
   ```bash
   sudo kubectl get nodes
   ```
2. **Install Kubernetes Gateway API CRDs** (Standard v1.1.0):
   ```bash
   sudo kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
   ```
3. **Install Envoy Gateway** (The Gateway API controller):
   ```bash
   helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.1.0 -n envoy-gateway-system --create-namespace
   ```
   *(If you don't have Helm, run `curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash` first)*
4. **Ensure AWS Security Group allows inbound Port 80 (HTTP)**:
   In AWS EC2 Console ➔ Security Groups ➔ Inbound Rules ➔ Add Rule: **HTTP (Port 80)** from `0.0.0.0/0`.
5. **Apply the Gateway manifest**:
   ```bash
   sudo kubectl apply -f https://raw.githubusercontent.com/kalees64/bluegreen/main/k8s/gateway/gateway.yaml
   ```

---

### Step 2: Push Repository Code to GitHub
Ensure all new deployment manifests and Docker files are committed and pushed:
```bash
git add .
git commit -m "feat: add Dockerfile, Nginx config, k8s manifests, and CI/CD workflow"
git push origin main
```

---

### Step 3: Initial Blue Deployment (Version 1.0)
1. Go to your GitHub repository ➔ **Actions** tab.
2. Select **Blue-Green CI/CD Pipeline** ➔ Click **Run workflow**:
   - `target_env`: **blue**
   - `image_tag`: **v1.0**
   - Click **Run workflow**.
3. **What happens**:
   - Docker image `kalees64/bluegreen:v1.0` is built and pushed to Docker Hub.
   - Deployed on K3s as `bluegreen-blue` (2 replicas).
   - HTTPRoute sets 100% traffic to `bluegreen-blue-svc`.
4. **Verify**:
   - Open your browser: `http://<YOUR-EC2-PUBLIC-IP>`
   - You will see the **BlueGreen v1.0** counter app running!
   - In **Portainer**: View the `bluegreen` namespace to see the 2 Blue pods running healthy.

---

### Step 4: Make Code Changes & Deploy Green (Version 2.0)
Now simulate a new production release:
1. In `src/App.jsx`, update the badge to `v2.0` and customize the header or counter features.
2. Update `package.json` version to `2.0.0`.
3. Commit and push:
   ```bash
   git add .
   git commit -m "feat: upgrade counter to v2.0 with enhanced UI"
   git push origin main
   ```
4. Trigger GitHub Actions:
   - `target_env`: **green**
   - `image_tag`: **v2.0**
   - Click **Run workflow**.
5. **What happens**:
   - Docker image `kalees64/bluegreen:v2.0` is pushed to Docker Hub.
   - Green deployment `bluegreen-green` spins up on K3s with 2 pods.
   - **Crucial Note**: Public traffic STILL sees Blue v1.0! Zero disruption.

---

### Step 5: Test Green in Production Before Cutover
Because the HTTPRoute includes a test rule, you can test Green directly:

1. **Using curl with the test header**:
   ```bash
   curl -i -H "X-Version: green" http://<YOUR-EC2-PUBLIC-IP>/
   ```
2. **Using your browser**:
   - Install the **ModHeader** Chrome/Edge extension.
   - Add request header: `X-Version: green`.
   - Refresh `http://<YOUR-EC2-PUBLIC-IP>`.
   - You will see the **v2.0 Green** app immediately, while any other device without this header sees **v1.0 Blue**!

---

### Step 6: Traffic Cutover (Zero Downtime)
Once you are confident with Green v2.0:
1. Go to GitHub Actions ➔ **Run workflow**:
   - `target_env`: **cutover-to-green**
   - Click **Run workflow**.
2. **What happens**:
   - The HTTPRoute flips traffic weights:
     - Blue: `weight: 0`
     - Green: `weight: 100`
   - All standard browser visits to `http://<YOUR-EC2-PUBLIC-IP>` now land on **v2.0** instantly!

---

### Step 7: Instant Rollback (If Needed)
If a critical bug is discovered in Green:
1. Go to GitHub Actions ➔ **Run workflow**:
   - `target_env`: **rollback-to-blue**
   - Click **Run workflow**.
2. **What happens**:
   - Traffic weights immediately flip back to Blue (`weight: 100` on Blue, `0` on Green).
   - Zero downtime recovery.

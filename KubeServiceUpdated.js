const express = require("express");
const { exec, execSync } = require("child_process");
const fs = require("fs");
const k8s = require("@kubernetes/client-node");
const app = express();

app.use(express.json());

const deploymentMap = {};

const kc = new k8s.KubeConfig();
const kubeconfigPath = "/etc/rancher/k3s/k3s.yaml";
kc.loadFromFile(kubeconfigPath);
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsV1Api = kc.makeApiClient(k8s.AppsV1Api);

app.post("/deploy", (req, res) => {
  const imageUrl = req.body.src;
  const taskID = 1;
  if (!imageUrl) {
    return res.status(400).send({ error: "No image URL provided" });
  }

  const deploymentName = `dynamic-deployment-${Math.random()
    .toString(36)
    .substring(7)}`;
  const filenameBase = deploymentName.replace(/[^a-zA-Z0-9-]/g, "");
  deploymentMap[taskID] = deploymentName;

  const serviceYaml = `
apiVersion: v1
kind: Service
metadata:
  name: ${deploymentName}-service
spec:
  type: NodePort
  selector:
    app: ${deploymentName}
  ports:
    - protocol: TCP
      port: 8080
      targetPort: 8080
`;

  const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
      - name: ${deploymentName}-container
        image: ${imageUrl}
`;

  fs.writeFileSync(`${filenameBase}.yaml`, deploymentYaml);
  fs.writeFileSync(`${filenameBase}-service.yaml`, serviceYaml);

  exec(
    `kubectl apply -f ${filenameBase}.yaml && kubectl apply -f ${filenameBase}-service.yaml`,
    (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return res
          .status(500)
          .send({ error: "Deployment or Service creation failed" });
          //.send(`Deployment or Service creation failed: ${error}`);
      }
      let nodePort;
      try {
        const getServiceCommand = `kubectl get svc ${deploymentName}-service -o=jsonpath='{.spec.ports[0].nodePort}'`;
        nodePort = execSync(getServiceCommand).toString().trim();
      } catch (error) {
        console.error("Error fetching NodePort:", error);
        return res.status(500).send({ error: "Failed to fetch NodePort" });
      }

      console.log(`stdout: ${stdout}`);
      console.error(`stderr: ${stderr}`);
      res.send({
        message: `Deployment ${deploymentName} and Service created`,
        nodePort: nodePort,
      });
    }
  );
});

app.get("/cluster-status", (req, res) => {
  console.log("check k3s status: ", req.params);

  res.json({
    deployment_status: true,
  });
});

app.get("/deployment-status/:taskId", async (req, res) => {
  const { taskId } = req.params;
  console.log("taskId1: ", taskId);
  if (!taskId) {
    return res.status(400).send({ error: "No task ID provided" });
  }

  try {
    const deploymentName = deploymentMap[taskId];
    if (!deploymentName) {
      return res
        .status(404)
        .send({ error: "Deployment not found for provided task ID" });
    }

    const deployment = await k8sAppsV1Api.readNamespacedDeployment(
      deploymentName,
      "default"
    );
    const status = deployment.body.status;

    res.json({ conditions: status.conditions });
  } catch (error) {
    console.error("Error fetching deployment status:", error);
    res.status(500).send({ error: "Failed to fetch deployment status" });
  }
});

app.get("/logs/:taskId", async (req, res) => {
  const { taskId } = req.params;
  if (!taskId) {
    return res.status(400).send({ error: "No task ID provided" });
  }

  try {
    const deploymentName = deploymentMap[taskId];
    if (!deploymentName) {
      return res
        .status(404)
        .send({ error: "Deployment not found for provided task ID" });
    }

    const command = `kubectl logs -l app=${deploymentName} --all-containers=true`;
    const logStream = exec(command);

    logStream.stdout.pipe(res);
    logStream.on("error", (error) => {
      console.error("Error streaming logs:", error);
      res.status(500).send({ error: "Failed to stream logs" });
    });
  } catch (error) {
    console.error("Error fetching deployment:", error);
    res.status(500).send({ error: "Failed to fetch deployment" });
  }
});

const port = 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
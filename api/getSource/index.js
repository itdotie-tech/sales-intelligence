const { BlobServiceClient } = require("@azure/storage-blob");

// One function, any number of sources. Each source is just a JSON file in
// the same private container, named after its source id — e.g. a source
// with id "crm" reads blob "crm.json". Power Automate (or any other sync
// job) writes one blob per source on its own schedule; this function only
// ever reads.
//
// Application Settings needed on the Static Web App (Azure Portal ->
// Configuration), never committed to source control:
//   AZURE_STORAGE_CONNECTION_STRING  connection string for the storage account
//   DATASET_CONTAINER                container name, e.g. "data-sync" (default below)

module.exports = async function (context, req) {
  const rawName = (req.params && req.params.name) || "";
  const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, "");

  if (!name) {
    context.res = { status: 400, body: { error: "Missing or invalid source name." } };
    return;
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.DATASET_CONTAINER || "data-sync";
  const blobName = name + ".json";

  if (!connectionString) {
    context.res = {
      status: 500,
      body: { error: "Storage connection is not configured. Set AZURE_STORAGE_CONNECTION_STRING in the app's Application Settings." }
    };
    return;
  }

  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    const exists = await blobClient.exists();
    if (!exists) {
      context.res = {
        status: 404,
        body: { error: "No data found yet for source '" + name + "'. The sync job hasn't run, or has not written to " + containerName + "/" + blobName + "." }
      };
      return;
    }

    const download = await blobClient.download();
    const text = await streamToString(download.readableStreamBody);

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: text
    };
  } catch (err) {
    context.log.error("getSource/" + name + " failed:", err);
    context.res = {
      status: 502,
      body: { error: "Could not read data for source '" + name + "' from storage." }
    };
  }
};

function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    readableStream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readableStream.on("error", reject);
  });
}

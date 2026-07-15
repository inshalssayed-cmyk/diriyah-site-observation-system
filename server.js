import "dotenv/config";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import pg from "pg";
import { v2 as cloudinary } from "cloudinary";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const statusPassword = process.env.STATUS_PASSWORD || "1353";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 4, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Only images are allowed."))
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS observation_daily_counters (
      observation_date DATE PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY,
      observation_number VARCHAR(32) NOT NULL UNIQUE,
      observation_date DATE NOT NULL,
      manual_issue_comment TEXT NOT NULL,
      ai_issue_comment TEXT NOT NULL,
      location TEXT NOT NULL,
      category TEXT NOT NULL,
      department TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      issue_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed','Reopened')),
      closeout_comment TEXT,
      closeout_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      reopened_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS observations_status_idx ON observations(status);
    CREATE INDEX IF NOT EXISTS observations_date_idx ON observations(observation_date DESC);
  `);
}

function requireStatusPassword(req, res, next) {
  if (req.get("x-status-password") !== statusPassword) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  next();
}

function publicObservation(row) {
  return {
    uniqueId: `UID-${String(row.id).padStart(6, "0")}`,
    id: String(row.id),
    observationNumber: row.observation_number,
    date: row.observation_date,
    manualIssueComment: row.manual_issue_comment,
    aiIssueComment: row.ai_issue_comment,
    location: row.location,
    category: row.category,
    department: row.department,
    issuedBy: row.issued_by,
    issueImages: row.issue_images || [],
    status: row.status,
    closeoutComment: row.closeout_comment || "",
    closeoutImages: row.closeout_images || [],
    issuedAt: row.issued_at,
    closedAt: row.closed_at,
    reopenedAt: row.reopened_at,
    updatedAt: row.updated_at
  };
}

async function uploadImages(files, folder) {
  return Promise.all((files || []).map(file => new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", quality: "auto", fetch_format: "auto" },
      (error, result) => error ? reject(error) : resolve({
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height
      })
    );
    stream.end(file.buffer);
  })));
}

async function generateGeminiIssueComment({ manualComment, location, category, department, files }) {
  const prompt = [
    "You are an HSE observation-writing assistant.",
    "Write exactly one short professional issue-observation sentence.",
    "Maximum 30 words.",
    "Describe only the unsafe act or unsafe condition.",
    "Do not provide recommendations.",
    "Do not change, suggest, repeat or output the category.",
    "Do not change, suggest, repeat or output the department.",
    "Do not invent details not visible in the images or stated in the manual comment.",
    "Return only the final sentence with no heading or bullet.",
    `Manual comment: ${manualComment}`,
    `Location: ${location}`,
    `Selected category (read-only): ${category}`,
    `Selected department (read-only): ${department}`
  ].join("\n");

  const contents = [
    { text: prompt },
    ...(files || []).map(file => ({
      inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") }
    }))
  ];

  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents
  });

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty issue comment.");
  return text.replace(/\s+/g, " ").slice(0, 350);
}

app.get("/api/health", async (_req, res) => {
  const result = await pool.query("SELECT NOW() AS now");
  res.json({ ok: true, databaseTime: result.rows[0].now, aiProvider: "Gemini" });
});

app.post("/api/status/login", (req, res) => {
  if (String(req.body?.password || "") !== statusPassword) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  res.json({ ok: true });
});

app.post("/api/observations", upload.array("images", 4), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { manualComment, location, category, department, issuedBy } = req.body;
    if (![manualComment, location, category, department, issuedBy].every(v => String(v || "").trim())) {
      return res.status(400).json({ error: "All required fields must be completed." });
    }
    if (!req.files?.length) {
      return res.status(400).json({ error: "At least one issue image is required." });
    }

    const observationDate = new Date().toISOString().slice(0, 10);
    const aiIssueComment = await generateGeminiIssueComment({
      manualComment: manualComment.trim(), location: location.trim(), category, department, files: req.files
    });
    const issueImages = await uploadImages(req.files, `diriyah-observations/issues/${observationDate}`);

    await client.query("BEGIN");
    const counter = await client.query(`
      INSERT INTO observation_daily_counters (observation_date, last_number)
      VALUES ($1, 1)
      ON CONFLICT (observation_date)
      DO UPDATE SET last_number = observation_daily_counters.last_number + 1
      RETURNING last_number
    `, [observationDate]);

    const number = `OBS-${observationDate.replaceAll("-", "")}-${String(counter.rows[0].last_number).padStart(3, "0")}`;
    const inserted = await client.query(`
      INSERT INTO observations (
        observation_number, observation_date, manual_issue_comment, ai_issue_comment,
        location, category, department, issued_by, issue_images, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'Open') RETURNING *
    `, [number, observationDate, manualComment.trim(), aiIssueComment, location.trim(), category, department, issuedBy.trim(), JSON.stringify(issueImages)]);

    await client.query("COMMIT");
    res.status(201).json(publicObservation(inserted.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/observations/open", async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM observations WHERE status IN ('Open','Reopened') ORDER BY issued_at DESC");
    res.json(result.rows.map(publicObservation));
  } catch (error) { next(error); }
});

app.post("/api/observations/:id/close", upload.array("images", 4), async (req, res, next) => {
  try {
    const closeoutComment = String(req.body.closeoutComment || "").trim();
    if (!closeoutComment || !req.files?.length) {
      return res.status(400).json({ error: "Closeout comment and at least one closeout image are required." });
    }
    const closeoutImages = await uploadImages(req.files, `diriyah-observations/closeouts/${req.params.id}`);
    const result = await pool.query(`
      UPDATE observations SET status='Closed', closeout_comment=$1, closeout_images=$2::jsonb,
      closed_at=NOW(), updated_at=NOW() WHERE id=$3 AND status IN ('Open','Reopened') RETURNING *
    `, [closeoutComment, JSON.stringify(closeoutImages), req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Open observation not found." });
    res.json(publicObservation(result.rows[0]));
  } catch (error) { next(error); }
});

app.get("/api/status/observations", requireStatusPassword, async (req, res, next) => {
  try {
    const { status = "", search = "", dateFrom = "", dateTo = "" } = req.query;
    const where = [], values = [];
    if (status && status !== "All") { values.push(status); where.push(`status=$${values.length}`); }
    if (dateFrom) { values.push(dateFrom); where.push(`observation_date >= $${values.length}`); }
    if (dateTo) { values.push(dateTo); where.push(`observation_date <= $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      where.push(`(observation_number ILIKE $${values.length} OR location ILIKE $${values.length} OR ai_issue_comment ILIKE $${values.length} OR category ILIKE $${values.length} OR department ILIKE $${values.length})`);
    }
    const result = await pool.query(`SELECT * FROM observations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY issued_at DESC`, values);
    res.json(result.rows.map(publicObservation));
  } catch (error) { next(error); }
});

app.post("/api/status/observations/:id/reopen", requireStatusPassword, async (req, res, next) => {
  try {
    const result = await pool.query("UPDATE observations SET status='Reopened', reopened_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='Closed' RETURNING *", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Closed observation not found." });
    res.json(publicObservation(result.rows[0]));
  } catch (error) { next(error); }
});

app.get("/api/status/download.csv", requireStatusPassword, async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM observations ORDER BY issued_at DESC");
    const cell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [["Unique ID","Date","Observation Number","AI Issue Comment","Location","Category","Department","Issued By","Status","Closeout Comment","Issued At","Closed At"],
      ...result.rows.map(row => [`UID-${String(row.id).padStart(6,"0")}`,row.observation_date,row.observation_number,row.ai_issue_comment,row.location,row.category,row.department,row.issued_by,row.status,row.closeout_comment||"",row.issued_at||"",row.closed_at||""])
    ];
    const csv = rows.map(row => row.map(cell).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="diriyah-observations-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (error) { next(error); }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Unexpected server error." });
});

initializeDatabase()
  .then(() => app.listen(port, () => console.log(`Diriyah Observation System running on port ${port}`)))
  .catch(error => { console.error(error); process.exit(1); });

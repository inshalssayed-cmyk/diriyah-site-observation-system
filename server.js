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
const statusPassword =
  process.env.STATUS_PASSWORD || "1353";

/* =====================================================
   REQUIRED ENVIRONMENT VARIABLES
===================================================== */

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL environment variable is required."
  );
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error(
    "GEMINI_API_KEY environment variable is required."
  );
}

/* =====================================================
   POSTGRESQL DATABASE
===================================================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl:
    process.env.NODE_ENV === "production"
      ? {
          rejectUnauthorized: false
        }
      : false
});

/* =====================================================
   GEMINI AI
===================================================== */

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const geminiModel =
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";

/* =====================================================
   CLOUDINARY
===================================================== */

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name:
      process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
      process.env.CLOUDINARY_API_KEY,

    api_secret:
      process.env.CLOUDINARY_API_SECRET,

    secure: true
  });
}

/* =====================================================
   IMAGE UPLOAD SETTINGS
===================================================== */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 4,
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: (_request, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(
        new Error(
          "Only image files are allowed."
        )
      );

      return;
    }

    callback(null, true);
  }
});

/* =====================================================
   EXPRESS MIDDLEWARE
===================================================== */

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =====================================================
   DATABASE INITIALIZATION
===================================================== */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS observation_daily_counters (
      observation_date DATE PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS observations (
      id BIGSERIAL PRIMARY KEY,

      observation_number VARCHAR(32)
        NOT NULL
        UNIQUE,

      observation_date DATE
        NOT NULL,

      manual_issue_comment TEXT
        NOT NULL,

      ai_issue_comment TEXT
        NOT NULL,

      location TEXT
        NOT NULL,

      category TEXT
        NOT NULL,

      department TEXT
        NOT NULL,

      issued_by TEXT
        NOT NULL,

      issue_images JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      status VARCHAR(20)
        NOT NULL
        DEFAULT 'Open'
        CHECK (
          status IN (
            'Open',
            'Closed',
            'Reopened'
          )
        ),

      closeout_comment TEXT,

      closeout_images JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      issued_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      closed_at TIMESTAMPTZ,

      reopened_at TIMESTAMPTZ,

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS
      observations_status_idx
      ON observations(status);

    CREATE INDEX IF NOT EXISTS
      observations_date_idx
      ON observations(
        observation_date DESC
      );
  `);
}

/* =====================================================
   PASSWORD PROTECTION
===================================================== */

function requireStatusPassword(
  request,
  response,
  next
) {
  const suppliedPassword =
    request.get("x-status-password");

  if (
    suppliedPassword !== statusPassword
  ) {
    response.status(401).json({
      error: "Incorrect password."
    });

    return;
  }

  next();
}

/* =====================================================
   DATABASE RECORD FORMAT
===================================================== */

function formatObservation(row) {
  return {
    uniqueId:
      `UID-${String(row.id).padStart(
        6,
        "0"
      )}`,

    id: String(row.id),

    observationNumber:
      row.observation_number,

    date:
      row.observation_date,

    manualIssueComment:
      row.manual_issue_comment,

    aiIssueComment:
      row.ai_issue_comment,

    location:
      row.location,

    category:
      row.category,

    department:
      row.department,

    issuedBy:
      row.issued_by,

    issueImages:
      row.issue_images || [],

    status:
      row.status,

    closeoutComment:
      row.closeout_comment || "",

    closeoutImages:
      row.closeout_images || [],

    issuedAt:
      row.issued_at,

    closedAt:
      row.closed_at,

    reopenedAt:
      row.reopened_at,

    updatedAt:
      row.updated_at
  };
}

/* =====================================================
   CLOUDINARY IMAGE UPLOAD
===================================================== */

async function uploadImagesToCloudinary(
  files,
  folder
) {
  if (!files || files.length === 0) {
    return [];
  }

  if (!cloudinaryConfigured) {
    throw new Error(
      "Cloudinary is not configured. Add the Cloudinary environment variables in Render."
    );
  }

  const uploadPromises = files.map(
    (file) =>
      new Promise((resolve, reject) => {
        const uploadStream =
          cloudinary.uploader.upload_stream(
            {
              folder,
              resource_type: "image",
              quality: "auto",
              fetch_format: "auto"
            },

            (error, result) => {
              if (error) {
                reject(error);
                return;
              }

              resolve({
                url: result.secure_url,
                publicId: result.public_id,
                width: result.width,
                height: result.height
              });
            }
          );

        uploadStream.end(file.buffer);
      })
  );

  return Promise.all(uploadPromises);
}

/* =====================================================
   GEMINI ISSUE COMMENT
===================================================== */

async function generateGeminiComment({
  manualComment,
  location,
  category,
  department,
  imageFiles
}) {
  const prompt = `
You are an HSE site-observation writing assistant.

Write exactly one short and professional issue-observation sentence.

Mandatory rules:
- Maximum 30 words.
- Describe only the unsafe act or unsafe condition.
- Do not provide recommendations.
- Do not change the category.
- Do not suggest a category.
- Do not output the category.
- Do not change the department.
- Do not suggest a department.
- Do not output the department.
- Do not invent information.
- Use only details visible in the images or written in the manual comment.
- Return only the final sentence.
- Do not include a heading, numbering, quotation marks or bullet point.

Manual comment:
${manualComment}

Location:
${location}

Selected category — read only:
${category}

Selected department — read only:
${department}
  `.trim();

  const contents = [
    {
      text: prompt
    },

    ...(imageFiles || []).map(
      (file) => ({
        inlineData: {
          mimeType: file.mimetype,

          data:
            file.buffer.toString(
              "base64"
            )
        }
      })
    )
  ];

  const result =
    await gemini.models.generateContent({
      model: geminiModel,
      contents
    });

  const generatedComment =
    result.text?.trim();

  if (!generatedComment) {
    throw new Error(
      "Gemini did not generate an issue comment."
    );
  }

  return generatedComment
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .slice(0, 350);
}

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
  "/api/health",
  async (_request, response, next) => {
    try {
      const databaseResult =
        await pool.query(
          "SELECT NOW() AS current_time"
        );

      response.json({
        ok: true,

        databaseTime:
          databaseResult.rows[0]
            .current_time,

        aiProvider: "Gemini",

        model: geminiModel,

        cloudinaryConfigured
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   STATUS PASSWORD LOGIN
===================================================== */

app.post(
  "/api/status/login",
  (request, response) => {
    const password = String(
      request.body?.password || ""
    );

    if (password !== statusPassword) {
      response.status(401).json({
        error: "Incorrect password."
      });

      return;
    }

    response.json({
      ok: true
    });
  }
);

/* =====================================================
   ISSUE A NEW OBSERVATION
===================================================== */

app.post(
  "/api/observations",

  upload.array("images", 4),

  async (request, response, next) => {
    const databaseClient =
      await pool.connect();

    try {
      const {
        manualComment,
        location,
        category,
        department,
        issuedBy
      } = request.body;

      const requiredValues = [
        manualComment,
        location,
        category,
        department,
        issuedBy
      ];

      const allFieldsCompleted =
        requiredValues.every(
          (value) =>
            String(value || "").trim()
        );

      if (!allFieldsCompleted) {
        response.status(400).json({
          error:
            "All required fields must be completed."
        });

        return;
      }

      if (
        !request.files ||
        request.files.length === 0
      ) {
        response.status(400).json({
          error:
            "At least one issue image is required."
        });

        return;
      }

      const observationDate =
        new Date()
          .toISOString()
          .slice(0, 10);

      /*
       * Gemini reads the original uploaded
       * images directly before Cloudinary
       * upload.
       */

      const aiIssueComment =
        await generateGeminiComment({
          manualComment:
            manualComment.trim(),

          location:
            location.trim(),

          category,

          department,

          imageFiles:
            request.files
        });

      /*
       * Permanently upload the issue
       * images to Cloudinary.
       */

      const issueImages =
        await uploadImagesToCloudinary(
          request.files,

          `diriyah-observations/issues/${observationDate}`
        );

      await databaseClient.query(
        "BEGIN"
      );

      /*
       * This transaction-safe daily
       * counter prevents duplicate
       * observation numbers.
       */

      const counterResult =
        await databaseClient.query(
          `
          INSERT INTO
            observation_daily_counters (
              observation_date,
              last_number
            )

          VALUES ($1, 1)

          ON CONFLICT (
            observation_date
          )

          DO UPDATE SET
            last_number =
              observation_daily_counters
                .last_number + 1

          RETURNING last_number
          `,

          [observationDate]
        );

      const dailySequence =
        counterResult.rows[0]
          .last_number;

      const compactDate =
        observationDate.replaceAll(
          "-",
          ""
        );

      const observationNumber =
        `OBS-${compactDate}-${String(
          dailySequence
        ).padStart(3, "0")}`;

      const insertResult =
        await databaseClient.query(
          `
          INSERT INTO observations (
            observation_number,
            observation_date,
            manual_issue_comment,
            ai_issue_comment,
            location,
            category,
            department,
            issued_by,
            issue_images,
            status
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::jsonb,
            'Open'
          )

          RETURNING *
          `,

          [
            observationNumber,
            observationDate,
            manualComment.trim(),
            aiIssueComment,
            location.trim(),
            category,
            department,
            issuedBy.trim(),
            JSON.stringify(issueImages)
          ]
        );

      await databaseClient.query(
        "COMMIT"
      );

      response
        .status(201)
        .json(
          formatObservation(
            insertResult.rows[0]
          )
        );
    } catch (error) {
      await databaseClient.query(
        "ROLLBACK"
      );

      next(error);
    } finally {
      databaseClient.release();
    }
  }
);

/* =====================================================
   GET ALL OPEN OBSERVATIONS
===================================================== */

app.get(
  "/api/observations/open",

  async (_request, response, next) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM observations

          WHERE status IN (
            'Open',
            'Reopened'
          )

          ORDER BY issued_at DESC
        `);

      response.json(
        result.rows.map(
          formatObservation
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   CLOSE AN OBSERVATION
===================================================== */

app.post(
  "/api/observations/:id/close",

  upload.array("images", 4),

  async (request, response, next) => {
    try {
      const observationId =
        request.params.id;

      const closeoutComment =
        String(
          request.body
            .closeoutComment || ""
        ).trim();

      if (!closeoutComment) {
        response.status(400).json({
          error:
            "Closeout comment is required."
        });

        return;
      }

      if (
        !request.files ||
        request.files.length === 0
      ) {
        response.status(400).json({
          error:
            "At least one closeout image is required."
        });

        return;
      }

      const closeoutImages =
        await uploadImagesToCloudinary(
          request.files,

          `diriyah-observations/closeouts/${observationId}`
        );

      const updateResult =
        await pool.query(
          `
          UPDATE observations

          SET
            status = 'Closed',

            closeout_comment = $1,

            closeout_images =
              $2::jsonb,

            closed_at = NOW(),

            updated_at = NOW()

          WHERE id = $3

          AND status IN (
            'Open',
            'Reopened'
          )

          RETURNING *
          `,

          [
            closeoutComment,
            JSON.stringify(
              closeoutImages
            ),
            observationId
          ]
        );

      if (
        updateResult.rowCount === 0
      ) {
        response.status(404).json({
          error:
            "Open observation not found."
        });

        return;
      }

      response.json(
        formatObservation(
          updateResult.rows[0]
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   GET OBSERVATION STATUS TABLE
===================================================== */

app.get(
  "/api/status/observations",

  requireStatusPassword,

  async (request, response, next) => {
    try {
      const status = String(
        request.query.status || ""
      ).trim();

      const search = String(
        request.query.search || ""
      ).trim();

      const dateFrom = String(
        request.query.dateFrom || ""
      ).trim();

      const dateTo = String(
        request.query.dateTo || ""
      ).trim();

      const conditions = [];
      const values = [];

      if (
        status &&
        status !== "All"
      ) {
        values.push(status);

        conditions.push(
          `status = $${values.length}`
        );
      }

      if (dateFrom) {
        values.push(dateFrom);

        conditions.push(
          `observation_date >= $${values.length}`
        );
      }

      if (dateTo) {
        values.push(dateTo);

        conditions.push(
          `observation_date <= $${values.length}`
        );
      }

      if (search) {
        values.push(`%${search}%`);

        conditions.push(`
          (
            observation_number
              ILIKE $${values.length}

            OR location
              ILIKE $${values.length}

            OR ai_issue_comment
              ILIKE $${values.length}

            OR category
              ILIKE $${values.length}

            OR department
              ILIKE $${values.length}

            OR issued_by
              ILIKE $${values.length}
          )
        `);
      }

      const whereClause =
        conditions.length
          ? `WHERE ${conditions.join(
              " AND "
            )}`
          : "";

      const result =
        await pool.query(
          `
          SELECT *
          FROM observations

          ${whereClause}

          ORDER BY issued_at DESC
          `,

          values
        );

      response.json(
        result.rows.map(
          formatObservation
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   REOPEN A CLOSED OBSERVATION
===================================================== */

app.post(
  "/api/status/observations/:id/reopen",

  requireStatusPassword,

  async (request, response, next) => {
    try {
      const result =
        await pool.query(
          `
          UPDATE observations

          SET
            status = 'Reopened',

            reopened_at = NOW(),

            updated_at = NOW()

          WHERE id = $1

          AND status = 'Closed'

          RETURNING *
          `,

          [request.params.id]
        );

      if (result.rowCount === 0) {
        response.status(404).json({
          error:
            "Closed observation not found."
        });

        return;
      }

      response.json(
        formatObservation(
          result.rows[0]
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   DOWNLOAD OBSERVATIONS AS CSV
===================================================== */

app.get(
  "/api/status/download.csv",

  requireStatusPassword,

  async (_request, response, next) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM observations
          ORDER BY issued_at DESC
        `);

      const formatCsvCell = (value) =>
        `"${String(value ?? "")
          .replaceAll('"', '""')}"`;

      const header = [
        "Unique ID",
        "Date",
        "Observation Number",
        "AI Issue Comment",
        "Location",
        "Category",
        "Department",
        "Issued By",
        "Status",
        "Closeout Comment",
        "Issued At",
        "Closed At"
      ];

      const rows =
        result.rows.map((row) => [
          `UID-${String(
            row.id
          ).padStart(6, "0")}`,

          row.observation_date,

          row.observation_number,

          row.ai_issue_comment,

          row.location,

          row.category,

          row.department,

          row.issued_by,

          row.status,

          row.closeout_comment || "",

          row.issued_at || "",

          row.closed_at || ""
        ]);

      const csvContent = [
        header,
        ...rows
      ]
        .map((row) =>
          row
            .map(formatCsvCell)
            .join(",")
        )
        .join("\n");

      const downloadDate =
        new Date()
          .toISOString()
          .slice(0, 10);

      response.setHeader(
        "Content-Type",
        "text/csv; charset=utf-8"
      );

      response.setHeader(
        "Content-Disposition",
        `attachment; filename="diriyah-observations-${downloadDate}.csv"`
      );

      response.send(
        "\uFEFF" + csvContent
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   EXPRESS 5 FRONTEND FALLBACK

   IMPORTANT:
   Express 5 does not accept app.get("*").
   The wildcard must have a name.
===================================================== */

app.get(
  "/{*splat}",

  (_request, response) => {
    response.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =====================================================
   GLOBAL ERROR HANDLER
===================================================== */

app.use(
  (error, _request, response, _next) => {
    console.error(error);

    let message =
      error.message ||
      "Unexpected server error.";

    let statusCode = 500;

    if (
      error instanceof
      multer.MulterError
    ) {
      statusCode = 400;

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        message =
          "Each image must be smaller than 8 MB.";
      }

      if (
        error.code ===
        "LIMIT_FILE_COUNT"
      ) {
        message =
          "A maximum of four images is allowed.";
      }
    }

    response
      .status(statusCode)
      .json({
        error: message
      });
  }
);

/* =====================================================
   START SERVER
===================================================== */

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(
        `Diriyah Observation System is running on port ${port}`
      );

      console.log(
        `Gemini model: ${geminiModel}`
      );

      console.log(
        `Cloudinary configured: ${cloudinaryConfigured}`
      );
    });
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });

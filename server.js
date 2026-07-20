import "dotenv/config";

import express from "express";
import helmet from "helmet";
import multer from "multer";
import pg from "pg";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const port = Number(process.env.PORT || 3000);
const statusPassword = process.env.STATUS_PASSWORD || "1353";
const geminiModel =
  process.env.GEMINI_MODEL ||
  "gemini-3.1-flash-lite";

const MAX_UPLOAD_FILES = 4;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_STORED_DIMENSION = 1600;
const STORED_JPEG_QUALITY = 78;

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
    files: 8,
    fileSize: MAX_UPLOAD_BYTES
  },

  fileFilter: (
    _request,
    file,
    callback
  ) => {
    if (
      !file.mimetype.startsWith(
        "image/"
      )
    ) {
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

const issueUpload = upload.array(
  "images",
  MAX_UPLOAD_FILES
);

const closeoutUpload = upload.array(
  "images",
  MAX_UPLOAD_FILES
);

const editUpload = upload.fields([
  {
    name: "issueImages",
    maxCount: MAX_UPLOAD_FILES
  },

  {
    name: "closeoutImages",
    maxCount: MAX_UPLOAD_FILES
  }
]);

/* =====================================================
   EXPRESS MIDDLEWARE
===================================================== */

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

const publicDirectory = path.join(
  __dirname,
  "public"
);

app.use(
  express.static(
    publicDirectory,
    {
      maxAge:
        process.env.NODE_ENV ===
        "production"
          ? "1d"
          : 0,

      setHeaders(
        response,
        filePath
      ) {
        if (
          filePath.endsWith(".html")
        ) {
          response.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, proxy-revalidate"
          );

          response.setHeader(
            "Pragma",
            "no-cache"
          );

          response.setHeader(
            "Expires",
            "0"
          );
        }
      }
    }
  )
);

/* =====================================================
   DATABASE INITIALIZATION
===================================================== */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS
      observation_daily_counters (
        observation_date DATE PRIMARY KEY,
        last_number INTEGER NOT NULL DEFAULT 0
      );

    CREATE TABLE IF NOT EXISTS
      observations (
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

    CREATE INDEX IF NOT EXISTS
      observations_issued_at_idx
      ON observations(
        issued_at DESC
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
    request.get(
      "x-status-password"
    );

  if (
    suppliedPassword !==
    statusPassword
  ) {
    response.status(401).json({
      error: "Incorrect password."
    });

    return;
  }

  next();
}

/* =====================================================
   GENERAL HELPERS
===================================================== */

function normalizeDateValue(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value
      .toISOString()
      .slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function formatObservation(row) {
  return {
    displaySerial:
      row.display_serial ===
        undefined ||
      row.display_serial === null
        ? null
        : Number(
            row.display_serial
          ),

    uniqueId:
      `UID-${String(
        row.id
      ).padStart(6, "0")}`,

    id: String(row.id),

    observationNumber:
      row.observation_number,

    date:
      normalizeDateValue(
        row.observation_date
      ),

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
      Array.isArray(
        row.issue_images
      )
        ? row.issue_images
        : [],

    status:
      row.status,

    closeoutComment:
      row.closeout_comment || "",

    closeoutImages:
      Array.isArray(
        row.closeout_images
      )
        ? row.closeout_images
        : [],

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

function ensureNumericId(value) {
  const id = String(
    value || ""
  ).trim();

  if (!/^\d+$/.test(id)) {
    throw Object.assign(
      new Error(
        "Invalid observation ID."
      ),
      {
        statusCode: 400
      }
    );
  }

  return id;
}

function validateDateFilter(
  value,
  label
) {
  if (!value) {
    return "";
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      value
    )
  ) {
    throw Object.assign(
      new Error(
        `${label} is invalid.`
      ),
      {
        statusCode: 400
      }
    );
  }

  return value;
}

function parseJsonArray(
  value,
  fallback = []
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  let parsed;

  try {
    parsed =
      typeof value === "string"
        ? JSON.parse(value)
        : value;
  } catch {
    throw Object.assign(
      new Error(
        "Image selection data is invalid."
      ),
      {
        statusCode: 400
      }
    );
  }

  if (!Array.isArray(parsed)) {
    throw Object.assign(
      new Error(
        "Image selection data is invalid."
      ),
      {
        statusCode: 400
      }
    );
  }

  return parsed.map(String);
}

function cleanRequiredText(
  value,
  fieldName,
  maximumLength = 1000
) {
  const cleaned = String(
    value || ""
  ).trim();

  if (!cleaned) {
    throw Object.assign(
      new Error(
        `${fieldName} is required.`
      ),
      {
        statusCode: 400
      }
    );
  }

  if (
    cleaned.length >
    maximumLength
  ) {
    throw Object.assign(
      new Error(
        `${fieldName} must be ${maximumLength} characters or fewer.`
      ),
      {
        statusCode: 400
      }
    );
  }

  return cleaned;
}

function cleanOptionalText(
  value,
  maximumLength = 2000
) {
  const cleaned = String(
    value || ""
  ).trim();

  if (
    cleaned.length >
    maximumLength
  ) {
    throw Object.assign(
      new Error(
        `Text must be ${maximumLength} characters or fewer.`
      ),
      {
        statusCode: 400
      }
    );
  }

  return cleaned;
}

function getStatusFilters(query) {
  const status = String(
    query.status || ""
  ).trim();

  const search = String(
    query.search || ""
  ).trim();

  const dateFrom =
    validateDateFilter(
      String(
        query.dateFrom || ""
      ).trim(),
      "Date from"
    );

  const dateTo =
    validateDateFilter(
      String(
        query.dateTo || ""
      ).trim(),
      "Date to"
    );

  if (
    status &&
    ![
      "All",
      "Open",
      "Closed",
      "Reopened"
    ].includes(status)
  ) {
    throw Object.assign(
      new Error(
        "Status filter is invalid."
      ),
      {
        statusCode: 400
      }
    );
  }

  return {
    status,
    search:
      search.slice(0, 200),
    dateFrom,
    dateTo
  };
}

function buildFilteredObservationsQuery(
  query,
  includeDisplaySerial = true
) {
  const {
    status,
    search,
    dateFrom,
    dateTo
  } = getStatusFilters(query);

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
    values.push(
      `%${search}%`
    );

    const parameter =
      `$${values.length}`;

    conditions.push(`
      (
        (
          'UID-' ||
          LPAD(
            id::text,
            6,
            '0'
          )
        ) ILIKE ${parameter}

        OR observation_number
          ILIKE ${parameter}

        OR manual_issue_comment
          ILIKE ${parameter}

        OR ai_issue_comment
          ILIKE ${parameter}

        OR location
          ILIKE ${parameter}

        OR category
          ILIKE ${parameter}

        OR department
          ILIKE ${parameter}

        OR issued_by
          ILIKE ${parameter}

        OR COALESCE(
          closeout_comment,
          ''
        ) ILIKE ${parameter}
      )
    `);
  }

  const whereClause =
    conditions.length
      ? `WHERE ${conditions.join(
          " AND "
        )}`
      : "";

  const displaySerialSelect =
    includeDisplaySerial
      ? `
        ROW_NUMBER()
        OVER (
          ORDER BY
            issued_at DESC,
            id DESC
        )
        AS display_serial,
      `
      : "";

  return {
    sql: `
      SELECT
        ${displaySerialSelect}
        observations.*

      FROM observations

      ${whereClause}

      ORDER BY
        issued_at DESC,
        id DESC
    `,

    values,

    filters: {
      status,
      search,
      dateFrom,
      dateTo
    }
  };
}

/* =====================================================
   SERVER-SIDE IMAGE COMPRESSION
===================================================== */

async function normalizeUploadedImage(
  file
) {
  try {
    const buffer =
      await sharp(
        file.buffer,
        {
          failOn: "none"
        }
      )
        .rotate()

        .resize({
          width:
            MAX_STORED_DIMENSION,

          height:
            MAX_STORED_DIMENSION,

          fit: "inside",

          withoutEnlargement: true
        })

        .flatten({
          background: "#ffffff"
        })

        .jpeg({
          quality:
            STORED_JPEG_QUALITY,

          mozjpeg: true
        })

        .toBuffer();

    return {
      ...file,

      buffer,

      mimetype:
        "image/jpeg",

      originalname:
        `${path.parse(
          file.originalname
        ).name}-compressed.jpg`,

      size:
        buffer.length
    };
  } catch {
    throw Object.assign(
      new Error(
        `The image “${file.originalname}” could not be processed. Please select a standard JPG, PNG, HEIC, WebP or browser-supported image.`
      ),
      {
        statusCode: 400
      }
    );
  }
}

async function normalizeUploadedImages(
  files
) {
  if (
    !files ||
    files.length === 0
  ) {
    return [];
  }

  return Promise.all(
    files.map(
      normalizeUploadedImage
    )
  );
}

/* =====================================================
   CLOUDINARY HELPERS
===================================================== */

async function uploadImagesToCloudinary(
  files,
  folder
) {
  if (
    !files ||
    files.length === 0
  ) {
    return [];
  }

  if (!cloudinaryConfigured) {
    throw new Error(
      "Cloudinary is not configured. Add the Cloudinary environment variables in Render."
    );
  }

  return Promise.all(
    files.map(
      (file) =>
        new Promise(
          (
            resolve,
            reject
          ) => {
            const uploadStream =
              cloudinary.uploader.upload_stream(
                {
                  folder,

                  resource_type:
                    "image",

                  format:
                    "jpg",

                  quality:
                    "auto:good",

                  fetch_format:
                    "auto",

                  overwrite:
                    false
                },

                (
                  error,
                  result
                ) => {
                  if (error) {
                    reject(error);
                    return;
                  }

                  resolve({
                    url:
                      result.secure_url,

                    publicId:
                      result.public_id,

                    width:
                      result.width,

                    height:
                      result.height,

                    bytes:
                      result.bytes
                  });
                }
              );

            uploadStream.end(
              file.buffer
            );
          }
        )
    )
  );
}

async function deleteCloudinaryImages(
  images
) {
  if (
    !cloudinaryConfigured ||
    !Array.isArray(images) ||
    images.length === 0
  ) {
    return [];
  }

  const publicIds = [
    ...new Set(
      images
        .map(
          (image) =>
            image?.publicId
        )
        .filter(
          (publicId) =>
            typeof publicId ===
              "string" &&
            publicId
        )
    )
  ];

  const results =
    await Promise.allSettled(
      publicIds.map(
        (publicId) =>
          cloudinary.uploader.destroy(
            publicId,
            {
              resource_type:
                "image",

              invalidate:
                true
            }
          )
      )
    );

  results.forEach(
    (
      result,
      index
    ) => {
      if (
        result.status ===
        "rejected"
      ) {
        console.warn(
          `Cloudinary deletion failed for ${publicIds[index]}:`,
          result.reason
        );
      }
    }
  );

  return results;
}

function getRetainedImages(
  existingImages,
  retainedPublicIds
) {
  const retainedSet =
    new Set(
      retainedPublicIds
    );

  return (
    Array.isArray(
      existingImages
    )
      ? existingImages
      : []
  ).filter(
    (image) =>
      image?.publicId &&
      retainedSet.has(
        String(
          image.publicId
        )
      )
  );
}

function getRemovedImages(
  existingImages,
  retainedImages
) {
  const retainedSet =
    new Set(
      retainedImages.map(
        (image) =>
          String(
            image.publicId
          )
      )
    );

  return (
    Array.isArray(
      existingImages
    )
      ? existingImages
      : []
  ).filter(
    (image) =>
      image?.publicId &&
      !retainedSet.has(
        String(
          image.publicId
        )
      )
  );
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
          mimeType:
            file.mimetype,

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
      model:
        geminiModel,

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
    .replace(
      /^["']|["']$/g,
      ""
    )
    .slice(0, 350);
}

/* =====================================================
   EXCEL IMAGE HELPERS
===================================================== */

async function fetchImageBuffer(
  url
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      15000
    );

  try {
    const response =
      await fetch(url, {
        signal:
          controller.signal,

        headers: {
          "User-Agent":
            "Diriyah-Observation-System/3.0"
        }
      });

    if (!response.ok) {
      throw new Error(
        `Image request returned ${response.status}.`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  } finally {
    clearTimeout(timeout);
  }
}

function getCollageLayout(
  count,
  width,
  height,
  gap
) {
  if (count === 1) {
    return [
      {
        left: 0,
        top: 0,
        width,
        height
      }
    ];
  }

  if (count === 2) {
    const tileWidth =
      Math.floor(
        (width - gap) / 2
      );

    return [
      {
        left: 0,
        top: 0,
        width:
          tileWidth,
        height
      },

      {
        left:
          tileWidth + gap,

        top: 0,

        width:
          width -
          tileWidth -
          gap,

        height
      }
    ];
  }

  if (count === 3) {
    const leftWidth =
      Math.floor(
        (width - gap) / 2
      );

    const rightHeight =
      Math.floor(
        (height - gap) / 2
      );

    return [
      {
        left: 0,
        top: 0,
        width:
          leftWidth,
        height
      },

      {
        left:
          leftWidth + gap,

        top: 0,

        width:
          width -
          leftWidth -
          gap,

        height:
          rightHeight
      },

      {
        left:
          leftWidth + gap,

        top:
          rightHeight + gap,

        width:
          width -
          leftWidth -
          gap,

        height:
          height -
          rightHeight -
          gap
      }
    ];
  }

  const tileWidth =
    Math.floor(
      (width - gap) / 2
    );

  const tileHeight =
    Math.floor(
      (height - gap) / 2
    );

  return [
    {
      left: 0,
      top: 0,
      width:
        tileWidth,
      height:
        tileHeight
    },

    {
      left:
        tileWidth + gap,

      top: 0,

      width:
        width -
        tileWidth -
        gap,

      height:
        tileHeight
    },

    {
      left: 0,

      top:
        tileHeight + gap,

      width:
        tileWidth,

      height:
        height -
        tileHeight -
        gap
    },

    {
      left:
        tileWidth + gap,

      top:
        tileHeight + gap,

      width:
        width -
        tileWidth -
        gap,

      height:
        height -
        tileHeight -
        gap
    }
  ];
}

async function createImageCollage(
  images
) {
  const selectedImages = (
    Array.isArray(images)
      ? images
      : []
  ).slice(0, 4);

  if (
    selectedImages.length === 0
  ) {
    return null;
  }

  const downloaded = [];

  for (
    const image of
    selectedImages
  ) {
    if (!image?.url) {
      continue;
    }

    try {
      downloaded.push(
        await fetchImageBuffer(
          image.url
        )
      );
    } catch (error) {
      console.warn(
        "Excel image could not be downloaded:",
        image.url,
        error.message
      );
    }
  }

  if (
    downloaded.length === 0
  ) {
    return null;
  }

  /*
   * Each Excel image cell receives one fixed-size collage.
   * This prevents Excel and mobile preview applications from
   * independently shrinking multiple pictures into vertical strips.
   */

  const canvasWidth = 920;
  const canvasHeight = 680;
  const outerPadding = 14;
  const gap = 12;

  const usableWidth =
    canvasWidth -
    outerPadding * 2;

  const usableHeight =
    canvasHeight -
    outerPadding * 2;

  const rawLayout =
    getCollageLayout(
      downloaded.length,
      usableWidth,
      usableHeight,
      gap
    );

  const composites = [];

  for (
    let index = 0;
    index <
    downloaded.length;
    index += 1
  ) {
    const rawTile =
      rawLayout[index];

    const tile = {
      left:
        rawTile.left +
        outerPadding,

      top:
        rawTile.top +
        outerPadding,

      width:
        rawTile.width,

      height:
        rawTile.height
    };

    /*
     * contain keeps the complete phone photograph visible.
     * rotate reads the phone orientation metadata automatically.
     */

    const fittedImage =
      await sharp(
        downloaded[index],
        {
          failOn: "none"
        }
      )
        .rotate()

        .resize({
          width:
            Math.max(
              1,
              tile.width - 8
            ),

          height:
            Math.max(
              1,
              tile.height - 8
            ),

          fit: "contain",

          position:
            "centre",

          background:
            "#ffffff",

          withoutEnlargement:
            false
        })

        .flatten({
          background:
            "#ffffff"
        })

        .jpeg({
          quality: 84,
          mozjpeg: true
        })

        .toBuffer();

    /*
     * Thin frame around each image.
     */

    const framedTile =
      await sharp({
        create: {
          width:
            tile.width,

          height:
            tile.height,

          channels: 3,

          background:
            "#c8d7e1"
        }
      })

        .composite([
          {
            input:
              fittedImage,

            left: 4,
            top: 4
          }
        ])

        .jpeg({
          quality: 86,
          mozjpeg: true
        })

        .toBuffer();

    composites.push({
      input:
        framedTile,

      left:
        tile.left,

      top:
        tile.top
    });
  }

  return sharp({
    create: {
      width:
        canvasWidth,

      height:
        canvasHeight,

      channels: 3,

      background:
        "#eef3f7"
    }
  })

    .composite(
      composites
    )

    .jpeg({
      quality: 86,
      mozjpeg: true
    })

    .toBuffer();
}

async function addLogoToWorkbook(
  workbook,
  worksheet
) {
  const logoPath =
    path.join(
      __dirname,
      "public",
      "assets",
      "diriyah-gold-logo.png"
    );

  try {
    const logoBuffer =
      await fs.readFile(
        logoPath
      );

    const preparedLogo =
      await sharp(
        logoBuffer,
        {
          failOn: "none"
        }
      )

        .trim({
          background: {
            r: 0,
            g: 0,
            b: 0,
            alpha: 0
          }
        })

        .resize({
          width: 520,
          height: 160,
          fit: "inside",
          withoutEnlargement:
            true
        })

        .png()

        .toBuffer();

    const logoId =
      workbook.addImage({
        buffer:
          preparedLogo,

        extension:
          "png"
      });

    worksheet.addImage(
      logoId,
      {
        tl: {
          col: 0.12,
          row: 0.18
        },

        br: {
          col: 3.85,
          row: 2.82
        },

        editAs:
          "oneCell"
      }
    );
  } catch (error) {
    console.warn(
      "Excel logo could not be added:",
      error.message
    );
  }
}

function addImageBufferToCell(
  workbook,
  worksheet,
  imageBuffer,
  rowNumber,
  columnIndex
) {
  const imageId =
    workbook.addImage({
      buffer:
        imageBuffer,

      extension:
        "jpeg"
    });

  /*
   * Excel image correction:
   *
   * Exact pixel dimensions are used instead of a bottom-right
   * cell anchor. Desktop Excel, mobile Excel and preview apps
   * can recalculate bottom-right anchors differently, which
   * previously caused images to become narrow vertical strips.
   */

  worksheet.addImage(
    imageId,
    {
      tl: {
        col:
          columnIndex +
          0.06,

        row:
          rowNumber -
          1 +
          0.06
      },

      ext: {
        width: 238,
        height: 180
      },

      editAs:
        "oneCell"
    }
  );
}

function excelDate(
  dateValue
) {
  const normalized =
    normalizeDateValue(
      dateValue
    );

  if (!normalized) {
    return null;
  }

  const [
    year,
    month,
    day
  ] = normalized
    .split("-")
    .map(Number);

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  );
}

function formatDateTimeForExcel(
  value
) {
  if (!value) {
    return null;
  }

  return value instanceof Date
    ? value
    : new Date(value);
}

async function createProfessionalExcel(
  observations,
  filters
) {
  const workbook =
    new ExcelJS.Workbook();

  workbook.creator =
    "BEC Arabia - Diriyah Site Observation System";

  workbook.lastModifiedBy =
    "Diriyah Site Observation System V3.0";

  workbook.created =
    new Date();

  workbook.modified =
    new Date();

  const worksheet =
    workbook.addWorksheet(
      "Observations",
      {
        views: [
          {
            state:
              "frozen",

            ySplit: 5,
            xSplit: 2,

            showGridLines:
              false
          }
        ],

        pageSetup: {
          orientation:
            "landscape",

          fitToPage:
            true,

          fitToWidth:
            1,

          fitToHeight:
            0,

          paperSize:
            9,

          margins: {
            left: 0.25,
            right: 0.25,
            top: 0.45,
            bottom: 0.45,
            header: 0.2,
            footer: 0.2
          }
        }
      }
    );

  worksheet.properties
    .defaultRowHeight = 20;

  worksheet.pageSetup
    .printTitlesRow = "5:5";

  worksheet.headerFooter
    .oddFooter =
      "&LGenerated by Diriyah Site Observation System&CPage &P of &N&R&F";

  worksheet.columns = [
    {
      key: "serial",
      width: 10
    },

    {
      key: "uniqueId",
      width: 17
    },

    {
      key: "date",
      width: 14
    },

    {
      key: "observationNumber",
      width: 23
    },

    {
      key: "manualIssueComment",
      width: 38
    },

    {
      key: "aiIssueComment",
      width: 42
    },

    {
      key: "location",
      width: 24
    },

    {
      key: "category",
      width: 25
    },

    {
      key: "department",
      width: 31
    },

    {
      key: "issuedBy",
      width: 20
    },

    {
      key: "issueImages",
      width: 36
    },

    {
      key: "status",
      width: 14
    },

    {
      key: "closeoutComment",
      width: 42
    },

    {
      key: "closeoutImages",
      width: 36
    },

    {
      key: "issuedAt",
      width: 21
    },

    {
      key: "closedAt",
      width: 21
    },

    {
      key: "updatedAt",
      width: 21
    }
  ];

  worksheet.getRow(1)
    .height = 34;

  worksheet.getRow(2)
    .height = 31;

  worksheet.getRow(3)
    .height = 25;

  worksheet.getRow(4)
    .height = 24;

  worksheet.getRow(5)
    .height = 36;

  worksheet.mergeCells(
    "D1:Q2"
  );

  worksheet.getCell("D1")
    .value =
      "DIRIYAH MEDIA RESIDENTIAL PROJECT";

  worksheet.getCell("D1")
    .font = {
      name: "Arial",
      size: 20,
      bold: true,

      color: {
        argb:
          "FF0A5797"
      }
    };

  worksheet.getCell("D1")
    .alignment = {
      vertical:
        "middle",

      horizontal:
        "center"
    };

  worksheet.mergeCells(
    "D3:Q3"
  );

  worksheet.getCell("D3")
    .value =
      "SITE OBSERVATION STATUS REPORT";

  worksheet.getCell("D3")
    .font = {
      name: "Arial",
      size: 13,
      bold: true,

      color: {
        argb:
          "FFC98D22"
      }
    };

  worksheet.getCell("D3")
    .alignment = {
      vertical:
        "middle",

      horizontal:
        "center"
    };

  worksheet.mergeCells(
    "A4:Q4"
  );

  const filterText = [
    filters.status &&
    filters.status !== "All"
      ? `Status: ${filters.status}`
      : "Status: All",

    filters.dateFrom
      ? `From: ${filters.dateFrom}`
      : "From: Beginning",

    filters.dateTo
      ? `To: ${filters.dateTo}`
      : "To: Today",

    filters.search
      ? `Search: ${filters.search}`
      : "Search: None",

    `Records: ${observations.length}`
  ].join(
    "   |   "
  );

  worksheet.getCell("A4")
    .value =
      filterText;

  worksheet.getCell("A4")
    .font = {
      size: 10,
      italic: true,

      color: {
        argb:
          "FF4D6170"
      }
    };

  worksheet.getCell("A4")
    .alignment = {
      vertical:
        "middle",

      horizontal:
        "center"
    };

  worksheet.getCell("A4")
    .fill = {
      type: "pattern",
      pattern: "solid",

      fgColor: {
        argb:
          "FFEAF5FB"
      }
    };

  await addLogoToWorkbook(
    workbook,
    worksheet
  );

  const headers = [
    "Display S.No.",
    "Database Unique ID",
    "Date",
    "Observation No.",
    "Manual Issue Comment",
    "AI Issue Comment",
    "Location",
    "Category",
    "Department",
    "Issued By",
    "Issue Images",
    "Status",
    "Closeout Comment",
    "Closeout Images",
    "Issued At",
    "Closed At",
    "Last Updated"
  ];

  worksheet.getRow(5)
    .values = headers;

  worksheet.autoFilter =
    "A5:Q5";

  worksheet.getRow(5)
    .eachCell(
      (cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",

          fgColor: {
            argb:
              "FF0A5797"
          }
        };

        cell.font = {
          bold: true,

          color: {
            argb:
              "FFFFFFFF"
          },

          size: 10
        };

        cell.alignment = {
          horizontal:
            "center",

          vertical:
            "middle",

          wrapText:
            true
        };

        cell.border = {
          top: {
            style:
              "thin",

            color: {
              argb:
                "FFFFFFFF"
            }
          },

          left: {
            style:
              "thin",

            color: {
              argb:
                "FFFFFFFF"
            }
          },

          bottom: {
            style:
              "thin",

            color: {
              argb:
                "FFFFFFFF"
            }
          },

          right: {
            style:
              "thin",

            color: {
              argb:
                "FFFFFFFF"
            }
          }
        };
      }
    );

  for (
    let index = 0;
    index <
    observations.length;
    index += 1
  ) {
    const observation =
      formatObservation(
        observations[index]
      );

    const rowNumber =
      6 + index;

    const row =
      worksheet.getRow(
        rowNumber
      );

    row.values = [
      index + 1,

      observation.uniqueId,

      excelDate(
        observation.date
      ),

      observation.observationNumber,

      observation.manualIssueComment,

      observation.aiIssueComment,

      observation.location,

      observation.category,

      observation.department,

      observation.issuedBy,

      observation.issueImages.length
        ? ""
        : "No images",

      observation.status,

      observation.closeoutComment ||
        "—",

      observation.closeoutImages.length
        ? ""
        : "No images",

      formatDateTimeForExcel(
        observation.issuedAt
      ),

      formatDateTimeForExcel(
        observation.closedAt
      ),

      formatDateTimeForExcel(
        observation.updatedAt
      )
    ];

    row.height = 150;

    const alternatingFill =
      index % 2 === 0
        ? "FFF8FBFD"
        : "FFEDF5F9";

    row.eachCell(
      {
        includeEmpty:
          true
      },

      (
        cell,
        columnNumber
      ) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",

          fgColor: {
            argb:
              alternatingFill
          }
        };

        cell.border = {
          top: {
            style:
              "thin",

            color: {
              argb:
                "FFB8C8D2"
            }
          },

          left: {
            style:
              "thin",

            color: {
              argb:
                "FFB8C8D2"
            }
          },

          bottom: {
            style:
              "thin",

            color: {
              argb:
                "FFB8C8D2"
            }
          },

          right: {
            style:
              "thin",

            color: {
              argb:
                "FFB8C8D2"
            }
          }
        };

        cell.alignment = {
          vertical:
            "middle",

          horizontal:
            [
              1,
              2,
              3,
              4,
              10,
              12,
              15,
              16,
              17
            ].includes(
              columnNumber
            )
              ? "center"
              : "left",

          wrapText:
            true
        };

        cell.font = {
          name:
            "Arial",

          size: 9,

          color: {
            argb:
              "FF17222C"
          }
        };
      }
    );

    row.getCell(3)
      .numFmt =
        "dd mmm yyyy";

    row.getCell(15)
      .numFmt =
        "dd mmm yyyy hh:mm";

    row.getCell(16)
      .numFmt =
        "dd mmm yyyy hh:mm";

    row.getCell(17)
      .numFmt =
        "dd mmm yyyy hh:mm";

    const statusCell =
      row.getCell(12);

    const statusStyles = {
      Open: {
        fill:
          "FFFFE8BF",

        font:
          "FF9A5700"
      },

      Closed: {
        fill:
          "FFD9F0DF",

        font:
          "FF1F6A2A"
      },

      Reopened: {
        fill:
          "FFDCEBFA",

        font:
          "FF155B8F"
      }
    };

    const statusStyle =
      statusStyles[
        observation.status
      ] ||
      statusStyles.Open;

    statusCell.fill = {
      type: "pattern",
      pattern: "solid",

      fgColor: {
        argb:
          statusStyle.fill
      }
    };

    statusCell.font = {
      bold: true,

      color: {
        argb:
          statusStyle.font
      },

      size: 9
    };

    statusCell.alignment = {
      vertical:
        "middle",

      horizontal:
        "center"
    };

    try {
      const issueCollage =
        await createImageCollage(
          observation.issueImages
        );

      if (issueCollage) {
        addImageBufferToCell(
          workbook,
          worksheet,
          issueCollage,
          rowNumber,
          10
        );
      }
    } catch (error) {
      row.getCell(11).value =
        "Issue image could not be embedded";

      console.warn(
        `Issue collage failed for ${observation.uniqueId}:`,
        error.message
      );
    }

    try {
      const closeoutCollage =
        await createImageCollage(
          observation.closeoutImages
        );

      if (
        closeoutCollage
      ) {
        addImageBufferToCell(
          workbook,
          worksheet,
          closeoutCollage,
          rowNumber,
          13
        );
      }
    } catch (error) {
      row.getCell(14).value =
        "Closeout image could not be embedded";

      console.warn(
        `Closeout collage failed for ${observation.uniqueId}:`,
        error.message
      );
    }

    row.commit();
  }

  worksheet.getColumn(5)
    .alignment = {
      wrapText: true,
      vertical: "middle"
    };

  worksheet.getColumn(6)
    .alignment = {
      wrapText: true,
      vertical: "middle"
    };

  worksheet.getColumn(13)
    .alignment = {
      wrapText: true,
      vertical: "middle"
    };

  return workbook.xlsx
    .writeBuffer();
}

/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
  "/api/health",

  async (
    _request,
    response,
    next
  ) => {
    try {
      const databaseResult =
        await pool.query(
          "SELECT NOW() AS current_time"
        );

      response.json({
        ok: true,

        version:
          "3.0.1",

        databaseTime:
          databaseResult
            .rows[0]
            .current_time,

        aiProvider:
          "Gemini",

        model:
          geminiModel,

        cloudinaryConfigured,

        excelExport:
          true,

        serverImageCompression:
          true
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

  (
    request,
    response
  ) => {
    const password =
      String(
        request.body
          ?.password ||
          ""
      );

    if (
      password !==
      statusPassword
    ) {
      response.status(401).json({
        error:
          "Incorrect password."
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

  issueUpload,

  async (
    request,
    response,
    next
  ) => {
    let uploadedIssueImages =
      [];

    const databaseClient =
      await pool.connect();

    let transactionStarted =
      false;

    try {
      const manualComment =
        cleanRequiredText(
          request.body
            .manualComment,

          "Manual comment",

          500
        );

      const location =
        cleanRequiredText(
          request.body
            .location,

          "Location",

          250
        );

      const category =
        cleanRequiredText(
          request.body
            .category,

          "Category",

          150
        );

      const department =
        cleanRequiredText(
          request.body
            .department,

          "Department",

          200
        );

      const issuedBy =
        cleanRequiredText(
          request.body
            .issuedBy,

          "Issued by",

          150
        );

      if (
        !request.files ||
        request.files.length ===
          0
      ) {
        throw Object.assign(
          new Error(
            "At least one issue image is required."
          ),
          {
            statusCode: 400
          }
        );
      }

      const normalizedFiles =
        await normalizeUploadedImages(
          request.files
        );

      const observationDate =
        new Date()
          .toISOString()
          .slice(0, 10);

      const aiIssueComment =
        await generateGeminiComment({
          manualComment,
          location,
          category,
          department,

          imageFiles:
            normalizedFiles
        });

      uploadedIssueImages =
        await uploadImagesToCloudinary(
          normalizedFiles,

          `diriyah-observations/issues/${observationDate}`
        );

      await databaseClient.query(
        "BEGIN"
      );

      transactionStarted =
        true;

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
            manualComment,
            aiIssueComment,
            location,
            category,
            department,
            issuedBy,

            JSON.stringify(
              uploadedIssueImages
            )
          ]
        );

      await databaseClient.query(
        "COMMIT"
      );

      transactionStarted =
        false;

      response
        .status(201)
        .json(
          formatObservation(
            insertResult
              .rows[0]
          )
        );
    } catch (error) {
      if (
        transactionStarted
      ) {
        await databaseClient
          .query("ROLLBACK")
          .catch(() => {});
      }

      if (
        uploadedIssueImages
          .length > 0
      ) {
        await deleteCloudinaryImages(
          uploadedIssueImages
        );
      }

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

  async (
    _request,
    response,
    next
  ) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM observations

          WHERE status IN (
            'Open',
            'Reopened'
          )

          ORDER BY
            issued_at DESC,
            id DESC
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

  closeoutUpload,

  async (
    request,
    response,
    next
  ) => {
    let uploadedCloseoutImages =
      [];

    try {
      const observationId =
        ensureNumericId(
          request.params.id
        );

      const closeoutComment =
        cleanRequiredText(
          request.body
            .closeoutComment,

          "Closeout comment",

          1000
        );

      if (
        !request.files ||
        request.files.length ===
          0
      ) {
        throw Object.assign(
          new Error(
            "At least one closeout image is required."
          ),
          {
            statusCode: 400
          }
        );
      }

      const normalizedFiles =
        await normalizeUploadedImages(
          request.files
        );

      uploadedCloseoutImages =
        await uploadImagesToCloudinary(
          normalizedFiles,

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
              uploadedCloseoutImages
            ),

            observationId
          ]
        );

      if (
        updateResult.rowCount ===
        0
      ) {
        await deleteCloudinaryImages(
          uploadedCloseoutImages
        );

        uploadedCloseoutImages =
          [];

        response.status(404).json({
          error:
            "Open observation not found."
        });

        return;
      }

      response.json(
        formatObservation(
          updateResult
            .rows[0]
        )
      );
    } catch (error) {
      if (
        uploadedCloseoutImages
          .length > 0
      ) {
        await deleteCloudinaryImages(
          uploadedCloseoutImages
        );
      }

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

  async (
    request,
    response,
    next
  ) => {
    try {
      const query =
        buildFilteredObservationsQuery(
          request.query,
          true
        );

      const result =
        await pool.query(
          query.sql,
          query.values
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
   EDIT AN OBSERVATION
===================================================== */

app.patch(
  "/api/status/observations/:id",

  requireStatusPassword,

  editUpload,

  async (
    request,
    response,
    next
  ) => {
    const observationId =
      ensureNumericId(
        request.params.id
      );

    let newlyUploadedImages =
      [];

    try {
      const existingResult =
        await pool.query(
          `
          SELECT *
          FROM observations
          WHERE id = $1
          `,

          [observationId]
        );

      if (
        existingResult.rowCount ===
        0
      ) {
        response.status(404).json({
          error:
            "Observation not found."
        });

        return;
      }

      const existing =
        existingResult.rows[0];

      const existingIssueImages =
        Array.isArray(
          existing.issue_images
        )
          ? existing.issue_images
          : [];

      const existingCloseoutImages =
        Array.isArray(
          existing.closeout_images
        )
          ? existing.closeout_images
          : [];

      const manualIssueComment =
        cleanRequiredText(
          request.body
            .manualIssueComment,

          "Manual issue comment",

          500
        );

      const aiIssueComment =
        cleanRequiredText(
          request.body
            .aiIssueComment,

          "AI issue comment",

          500
        );

      const location =
        cleanRequiredText(
          request.body
            .location,

          "Location",

          250
        );

      const category =
        cleanRequiredText(
          request.body
            .category,

          "Category",

          150
        );

      const department =
        cleanRequiredText(
          request.body
            .department,

          "Department",

          200
        );

      const issuedBy =
        cleanRequiredText(
          request.body
            .issuedBy,

          "Issued by",

          150
        );

      const status =
        cleanRequiredText(
          request.body
            .status,

          "Status",

          20
        );

      const closeoutComment =
        cleanOptionalText(
          request.body
            .closeoutComment,

          1000
        );

      if (
        ![
          "Open",
          "Closed",
          "Reopened"
        ].includes(status)
      ) {
        throw Object.assign(
          new Error(
            "Status is invalid."
          ),
          {
            statusCode: 400
          }
        );
      }

      const defaultIssueIds =
        existingIssueImages
          .map(
            (image) =>
              image?.publicId
          )
          .filter(Boolean);

      const defaultCloseoutIds =
        existingCloseoutImages
          .map(
            (image) =>
              image?.publicId
          )
          .filter(Boolean);

      const retainedIssueIds =
        parseJsonArray(
          request.body
            .retainIssuePublicIds,

          defaultIssueIds
        );

      const retainedCloseoutIds =
        parseJsonArray(
          request.body
            .retainCloseoutPublicIds,

          defaultCloseoutIds
        );

      const retainedIssueImages =
        getRetainedImages(
          existingIssueImages,
          retainedIssueIds
        );

      const retainedCloseoutImages =
        getRetainedImages(
          existingCloseoutImages,
          retainedCloseoutIds
        );

      const newIssueFiles =
        await normalizeUploadedImages(
          request.files
            ?.issueImages ||
            []
        );

      const newCloseoutFiles =
        await normalizeUploadedImages(
          request.files
            ?.closeoutImages ||
            []
        );

      if (
        retainedIssueImages.length +
          newIssueFiles.length >
        4
      ) {
        throw Object.assign(
          new Error(
            "A maximum of four issue images is allowed."
          ),
          {
            statusCode: 400
          }
        );
      }

      if (
        retainedCloseoutImages.length +
          newCloseoutFiles.length >
        4
      ) {
        throw Object.assign(
          new Error(
            "A maximum of four closeout images is allowed."
          ),
          {
            statusCode: 400
          }
        );
      }

      if (
        retainedIssueImages.length +
          newIssueFiles.length ===
        0
      ) {
        throw Object.assign(
          new Error(
            "At least one issue image is required."
          ),
          {
            statusCode: 400
          }
        );
      }

      if (
        status === "Closed" &&
        (
          !closeoutComment ||
          retainedCloseoutImages.length +
            newCloseoutFiles.length ===
            0
        )
      ) {
        throw Object.assign(
          new Error(
            "A closed observation requires a closeout comment and at least one closeout image."
          ),
          {
            statusCode: 400
          }
        );
      }

      const uploadedIssueImages =
        await uploadImagesToCloudinary(
          newIssueFiles,

          `diriyah-observations/issues/${normalizeDateValue(
            existing.observation_date
          )}`
        );

      newlyUploadedImages.push(
        ...uploadedIssueImages
      );

      const uploadedCloseoutImages =
        await uploadImagesToCloudinary(
          newCloseoutFiles,

          `diriyah-observations/closeouts/${observationId}`
        );

      newlyUploadedImages.push(
        ...uploadedCloseoutImages
      );

      const finalIssueImages = [
        ...retainedIssueImages,
        ...uploadedIssueImages
      ];

      const finalCloseoutImages = [
        ...retainedCloseoutImages,
        ...uploadedCloseoutImages
      ];

      const updateResult =
        await pool.query(
          `
          UPDATE observations

          SET
            manual_issue_comment = $1,

            ai_issue_comment = $2,

            location = $3,

            category = $4,

            department = $5,

            issued_by = $6,

            issue_images =
              $7::jsonb,

            status = $8,

            closeout_comment =
              NULLIF($9, ''),

            closeout_images =
              $10::jsonb,

            closed_at =
              CASE
                WHEN $8 = 'Closed'
                  THEN COALESCE(
                    closed_at,
                    NOW()
                  )

                ELSE closed_at
              END,

            reopened_at =
              CASE
                WHEN
                  $8 = 'Reopened'
                  AND status <> 'Reopened'

                  THEN NOW()

                ELSE reopened_at
              END,

            updated_at = NOW()

          WHERE id = $11

          RETURNING *
          `,

          [
            manualIssueComment,
            aiIssueComment,
            location,
            category,
            department,
            issuedBy,

            JSON.stringify(
              finalIssueImages
            ),

            status,

            closeoutComment,

            JSON.stringify(
              finalCloseoutImages
            ),

            observationId
          ]
        );

      if (
        updateResult.rowCount ===
        0
      ) {
        throw Object.assign(
          new Error(
            "Observation not found."
          ),
          {
            statusCode: 404
          }
        );
      }

      const removedImages = [
        ...getRemovedImages(
          existingIssueImages,
          retainedIssueImages
        ),

        ...getRemovedImages(
          existingCloseoutImages,
          retainedCloseoutImages
        )
      ];

      await deleteCloudinaryImages(
        removedImages
      );

      newlyUploadedImages =
        [];

      response.json(
        formatObservation(
          updateResult
            .rows[0]
        )
      );
    } catch (error) {
      if (
        newlyUploadedImages
          .length > 0
      ) {
        await deleteCloudinaryImages(
          newlyUploadedImages
        );
      }

      next(error);
    }
  }
);

/* =====================================================
   DELETE AN OBSERVATION
===================================================== */

app.delete(
  "/api/status/observations/:id",

  requireStatusPassword,

  async (
    request,
    response,
    next
  ) => {
    const observationId =
      ensureNumericId(
        request.params.id
      );

    const client =
      await pool.connect();

    let transactionStarted =
      false;

    try {
      await client.query(
        "BEGIN"
      );

      transactionStarted =
        true;

      const selected =
        await client.query(
          `
          SELECT *
          FROM observations
          WHERE id = $1
          FOR UPDATE
          `,

          [observationId]
        );

      if (
        selected.rowCount === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        transactionStarted =
          false;

        response.status(404).json({
          error:
            "Observation not found."
        });

        return;
      }

      await client.query(
        `
        DELETE FROM observations
        WHERE id = $1
        `,

        [observationId]
      );

      await client.query(
        "COMMIT"
      );

      transactionStarted =
        false;

      const deletedRow =
        selected.rows[0];

      await deleteCloudinaryImages([
        ...(
          Array.isArray(
            deletedRow.issue_images
          )
            ? deletedRow.issue_images
            : []
        ),

        ...(
          Array.isArray(
            deletedRow.closeout_images
          )
            ? deletedRow.closeout_images
            : []
        )
      ]);

      response.json({
        ok: true,

        deletedId:
          observationId,

        uniqueId:
          `UID-${String(
            observationId
          ).padStart(6, "0")}`
      });
    } catch (error) {
      if (
        transactionStarted
      ) {
        await client
          .query("ROLLBACK")
          .catch(() => {});
      }

      next(error);
    } finally {
      client.release();
    }
  }
);

/* =====================================================
   REOPEN A CLOSED OBSERVATION
===================================================== */

app.post(
  "/api/status/observations/:id/reopen",

  requireStatusPassword,

  async (
    request,
    response,
    next
  ) => {
    try {
      const observationId =
        ensureNumericId(
          request.params.id
        );

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

          [observationId]
        );

      if (
        result.rowCount === 0
      ) {
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
   PROFESSIONAL EXCEL DOWNLOAD
===================================================== */

app.get(
  "/api/status/download.xlsx",

  requireStatusPassword,

  async (
    request,
    response,
    next
  ) => {
    try {
      const query =
        buildFilteredObservationsQuery(
          request.query,
          true
        );

      const result =
        await pool.query(
          query.sql,
          query.values
        );

      const excelBuffer =
        await createProfessionalExcel(
          result.rows,
          query.filters
        );

      const downloadDate =
        new Date()
          .toISOString()
          .slice(0, 10);

      response.setHeader(
        "Content-Type",

        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      response.setHeader(
        "Content-Disposition",

        `attachment; filename="diriyah-observation-status-${downloadDate}.xlsx"`
      );

      response.setHeader(
        "Content-Length",

        String(
          excelBuffer.length
        )
      );

      response.end(
        excelBuffer
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   LEGACY CSV DOWNLOAD
===================================================== */

app.get(
  "/api/status/download.csv",

  requireStatusPassword,

  async (
    request,
    response,
    next
  ) => {
    try {
      const query =
        buildFilteredObservationsQuery(
          request.query,
          true
        );

      const result =
        await pool.query(
          query.sql,
          query.values
        );

      const formatCsvCell =
        (value) =>
          `"${String(
            value ?? ""
          ).replaceAll(
            '"',
            '""'
          )}"`;

      const header = [
        "Display S.No.",
        "Database Unique ID",
        "Date",
        "Observation Number",
        "Manual Issue Comment",
        "AI Issue Comment",
        "Location",
        "Category",
        "Department",
        "Issued By",
        "Status",
        "Closeout Comment",
        "Issued At",
        "Closed At",
        "Updated At"
      ];

      const rows =
        result.rows.map(
          (
            row,
            index
          ) => {
            const observation =
              formatObservation(
                row
              );

            return [
              index + 1,

              observation.uniqueId,

              observation.date,

              observation.observationNumber,

              observation.manualIssueComment,

              observation.aiIssueComment,

              observation.location,

              observation.category,

              observation.department,

              observation.issuedBy,

              observation.status,

              observation.closeoutComment,

              observation.issuedAt ||
                "",

              observation.closedAt ||
                "",

              observation.updatedAt ||
                ""
            ];
          }
        );

      const csvContent = [
        header,
        ...rows
      ]
        .map(
          (row) =>
            row
              .map(
                formatCsvCell
              )
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
        "\uFEFF" +
          csvContent
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =====================================================
   EXPRESS 5 FRONTEND FALLBACK
===================================================== */

app.get(
  "/{*splat}",

  (
    _request,
    response
  ) => {
    response.sendFile(
      path.join(
        publicDirectory,
        "index.html"
      )
    );
  }
);

/* =====================================================
   GLOBAL ERROR HANDLER
===================================================== */

app.use(
  (
    error,
    _request,
    response,
    _next
  ) => {
    console.error(error);

    let message =
      error.message ||
      "Unexpected server error.";

    let statusCode =
      error.statusCode ||
      500;

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
          "Each original image must be smaller than 12 MB.";
      } else if (
        error.code ===
          "LIMIT_FILE_COUNT" ||
        error.code ===
          "LIMIT_UNEXPECTED_FILE"
      ) {
        message =
          "A maximum of four images is allowed in each image section.";
      }
    }

    if (
      error instanceof
        SyntaxError &&
      "body" in error
    ) {
      statusCode = 400;

      message =
        "The submitted data is invalid.";
    }

    if (
      error.code ===
      "23505"
    ) {
      statusCode = 409;

      message =
        "A duplicate observation number was detected. Please try again.";
    }

    response
      .status(statusCode)
      .json({
        error:
          message
      });
  }
);

/* =====================================================
   START SERVER
===================================================== */

initializeDatabase()
  .then(() => {
    app.listen(
      port,
      () => {
        console.log(
          `Diriyah Observation System V3.0.1 is running on port ${port}`
        );

        console.log(
          `Gemini model: ${geminiModel}`
        );

        console.log(
          `Cloudinary configured: ${cloudinaryConfigured}`
        );

        console.log(
          "Professional Excel export: enabled"
        );

        console.log(
          "Server-side image compression: enabled"
        );
      }
    );
  })

  .catch(
    (error) => {
      console.error(
        "Database initialization failed:",
        error
      );

      process.exit(1);
    }
  );

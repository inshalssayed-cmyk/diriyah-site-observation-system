import "dotenv/config";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import pg from "pg";
import { v2 as cloudinary } from "cloudinary";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const statusPassword = process.env.STATUS_PASSWORD || "1353";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const cloudinaryReady = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryReady) cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});

const upload = multer({storage:multer.memoryStorage(),limits:{files:4,fileSize:8*1024*1024},fileFilter:(_r,f,cb)=>f.mimetype.startsWith("image/")?cb(null,true):cb(new Error("Only images allowed."))});
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

async function init(){await pool.query(`
CREATE TABLE IF NOT EXISTS observation_daily_counters(observation_date DATE PRIMARY KEY,last_number INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS observations(
 id BIGSERIAL PRIMARY KEY,
 observation_number VARCHAR(32) UNIQUE NOT NULL,
 observation_date DATE NOT NULL,
 manual_issue_comment TEXT NOT NULL,
 ai_issue_comment TEXT NOT NULL,
 location TEXT NOT NULL,
 category TEXT NOT NULL,
 department TEXT NOT NULL,
 issued_by TEXT NOT NULL,
 issue_images JSONB NOT NULL DEFAULT '[]'::jsonb,
 status VARCHAR(20) NOT NULL DEFAULT 'Open' CHECK(status IN('Open','Closed','Reopened')),
 closeout_comment TEXT,
 closeout_images JSONB NOT NULL DEFAULT '[]'::jsonb,
 issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 closed_at TIMESTAMPTZ,
 reopened_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS observations_status_idx ON observations(status);
CREATE INDEX IF NOT EXISTS observations_date_idx ON observations(observation_date DESC);`)}
function auth(req,res,next){if(req.get("x-status-password")!==statusPassword)return res.status(401).json({error:"Incorrect password."});next()}
function shape(r){return{uniqueId:`UID-${String(r.id).padStart(6,"0")}`,id:String(r.id),observationNumber:r.observation_number,date:r.observation_date,manualIssueComment:r.manual_issue_comment,aiIssueComment:r.ai_issue_comment,location:r.location,category:r.category,department:r.department,issuedBy:r.issued_by,issueImages:r.issue_images||[],status:r.status,closeoutComment:r.closeout_comment||"",closeoutImages:r.closeout_images||[],issuedAt:r.issued_at,closedAt:r.closed_at,reopenedAt:r.reopened_at}}
async function uploadImages(files,folder){if(!files?.length)return[];if(!cloudinaryReady)throw new Error("Cloudinary environment variables are missing.");return Promise.all(files.map(file=>new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_stream({folder,resource_type:"image",quality:"auto",fetch_format:"auto"},(e,r)=>e?reject(e):resolve({url:r.secure_url,publicId:r.public_id}));stream.end(file.buffer)})))}
async function aiComment(data,urls){const fallback=data.manualComment.trim().replace(/\s+/g," ").slice(0,240);if(!openai)return fallback;const content=[{type:"input_text",text:`Write exactly one short professional HSE issue-observation sentence, maximum 30 words. Describe only the unsafe act or condition. Do not recommend. Do not change category or department. Do not invent details. Return only the sentence.\nManual comment: ${data.manualComment}\nLocation: ${data.location}\nCategory (read-only): ${data.category}\nDepartment (read-only): ${data.department}`},...urls.map(url=>({type:"input_image",image_url:url}))];const r=await openai.responses.create({model:process.env.OPENAI_MODEL||"gpt-4.1-mini",input:[{role:"user",content}],max_output_tokens:100});return r.output_text?.trim()||fallback}

app.get("/api/health",async(_q,res)=>res.json({ok:true,time:(await pool.query("SELECT NOW() now")).rows[0].now}));
app.post("/api/status/login",(req,res)=>String(req.body?.password||"")===statusPassword?res.json({ok:true}):res.status(401).json({error:"Incorrect password."}));
app.post("/api/observations",upload.array("images",4),async(req,res,next)=>{const client=await pool.connect();try{const d={manualComment:String(req.body.manualComment||"").trim(),location:String(req.body.location||"").trim(),category:String(req.body.category||"").trim(),department:String(req.body.department||"").trim(),issuedBy:String(req.body.issuedBy||"").trim()};if(Object.values(d).some(v=>!v))return res.status(400).json({error:"Complete all required fields."});const date=new Date().toISOString().slice(0,10);const images=await uploadImages(req.files,`diriyah/issues/${date}`);const ai=await aiComment(d,images.map(x=>x.url));await client.query("BEGIN");const c=await client.query(`INSERT INTO observation_daily_counters(observation_date,last_number) VALUES($1,1) ON CONFLICT(observation_date) DO UPDATE SET last_number=observation_daily_counters.last_number+1 RETURNING last_number`,[date]);const no=`OBS-${date.replaceAll("-","")}-${String(c.rows[0].last_number).padStart(3,"0")}`;const r=await client.query(`INSERT INTO observations(observation_number,observation_date,manual_issue_comment,ai_issue_comment,location,category,department,issued_by,issue_images) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[no,date,d.manualComment,ai,d.location,d.category,d.department,d.issuedBy,JSON.stringify(images)]);await client.query("COMMIT");res.status(201).json(shape(r.rows[0]))}catch(e){await client.query("ROLLBACK");next(e)}finally{client.release()}});
app.get("/api/observations/open",async(_q,res,next)=>{try{const r=await pool.query(`SELECT * FROM observations WHERE status IN('Open','Reopened') ORDER BY issued_at DESC`);res.json(r.rows.map(shape))}catch(e){next(e)}});
app.post("/api/observations/:id/close",upload.array("images",4),async(req,res,next)=>{try{const comment=String(req.body.closeoutComment||"").trim();if(!comment||!req.files?.length)return res.status(400).json({error:"Comment and closeout image are required."});const images=await uploadImages(req.files,`diriyah/closeouts/${req.params.id}`);const r=await pool.query(`UPDATE observations SET status='Closed',closeout_comment=$1,closeout_images=$2::jsonb,closed_at=NOW(),updated_at=NOW() WHERE id=$3 AND status IN('Open','Reopened') RETURNING *`,[comment,JSON.stringify(images),req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Open observation not found."});res.json(shape(r.rows[0]))}catch(e){next(e)}});
app.get("/api/status/observations",auth,async(req,res,next)=>{try{const vals=[],where=[];for(const [key,col] of [["status","status"],["dateFrom","observation_date >="],["dateTo","observation_date <="]]){const v=String(req.query[key]||"");if(v&&!(key==="status"&&v==="All")){vals.push(v);where.push(key==="status"?`${col}=$${vals.length}`:`${col} $${vals.length}`)}}const s=String(req.query.search||"").trim();if(s){vals.push(`%${s}%`);where.push(`(observation_number ILIKE $${vals.length} OR location ILIKE $${vals.length} OR ai_issue_comment ILIKE $${vals.length})`)}const r=await pool.query(`SELECT * FROM observations ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY issued_at DESC`,vals);res.json(r.rows.map(shape))}catch(e){next(e)}});
app.post("/api/status/observations/:id/reopen",auth,async(req,res,next)=>{try{const r=await pool.query(`UPDATE observations SET status='Reopened',reopened_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='Closed' RETURNING *`,[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Closed observation not found."});res.json(shape(r.rows[0]))}catch(e){next(e)}});
app.get("/api/status/download.csv",auth,async(_q,res,next)=>{try{const r=await pool.query(`SELECT * FROM observations ORDER BY issued_at DESC`);const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;const rows=[["Unique ID","Date","Observation Number","AI Issue Comment","Location","Category","Department","Issued By","Status","Closeout Comment"],...r.rows.map(x=>[`UID-${String(x.id).padStart(6,"0")}`,x.observation_date,x.observation_number,x.ai_issue_comment,x.location,x.category,x.department,x.issued_by,x.status,x.closeout_comment||""])];res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename=diriyah-observations-${new Date().toISOString().slice(0,10)}.csv`);res.send("\uFEFF"+rows.map(row=>row.map(esc).join(",")).join("\n"))}catch(e){next(e)}});
app.get("*",(_q,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((e,_q,res,_n)=>{console.error(e);res.status(500).json({error:e.message||"Server error."})});
init().then(()=>app.listen(port,()=>console.log(`Running on ${port}`))).catch(e=>{console.error(e);process.exit(1)});

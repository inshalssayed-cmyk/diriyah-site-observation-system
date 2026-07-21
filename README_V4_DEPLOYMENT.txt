DIRIYAH MULTI-PROJECT SITE OBSERVATION SYSTEM — VERSION 4.0.0
================================================================

PROJECTS
--------
1. Diriyah - One Hotel (ONE_HOTEL)
   Observation Status password: 9528
2. Diriyah - Media Residential (MRES)
   Observation Status password: 1353
3. Diriyah - Media South Office (MSO)
   Observation Status password: 1353

WHAT CHANGED
------------
- Added a first project-selection screen.
- All three projects use the same Issue, Close and Observation Status system.
- Every observation is saved with a project code.
- Open observations, status records, edit, delete, reopen, Excel and CSV are separated by project.
- Existing records are automatically assigned to MRES.
- New daily observation numbers are independent for each project:
  MRES-YYYYMMDD-001
  MSO-YYYYMMDD-001
  OH-YYYYMMDD-001
- Excel titles and file names change automatically by project.
- The Claude image processing and Excel image logic are retained unchanged.

FILES TO REPLACE IN GITHUB
--------------------------
server.js
package.json
package-lock.json
render.yaml
public/index.html

KEEP THESE ASSETS IN THE SAME PATH
----------------------------------
public/assets/diriyah-gold-logo.png
public/assets/diriyah-heritage-footer.jpg

DEPLOYMENT
----------
1. Replace the files in GitHub using the same paths.
2. Commit the changes.
3. Render will automatically deploy.
4. Open /api/health and confirm:
   version: 4.0.0
   multiProject: true
5. Open the main website and test each project separately.

DATABASE
--------
No manual SQL is required. server.js automatically:
- Adds project_code to the observations table.
- Assigns all existing observations to MRES.
- Creates the project-specific daily counter table and indexes.

IMPORTANT
---------
Do not delete the existing PostgreSQL database or Cloudinary records.

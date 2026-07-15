# Diriyah Shared Site Observation System

This version uses a shared Render PostgreSQL database. Every phone and laptop opening the same deployed Web Service URL sees the same records.

## Render setup

1. Upload all project files to a new GitHub repository.
2. In Render, use **New > Blueprint** and select the repository containing `render.yaml`.
3. Render creates the Web Service and PostgreSQL database.
4. Add the secret environment variables when requested:
   - `OPENAI_API_KEY`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
5. Deploy and open the new **Web Service URL**.

The status password is `1353` unless changed in Render.

Do not upload API keys to GitHub. The backend creates database tables automatically.

The SQLite schema in this project has some date columns, yet they are stored as text. 
Similarly, probably there are other columns that could have more specific types.

I would like to use more specific types for the columns in the SQLite schema, especially for date columns.
Let's take into account best practices for SQLite schema design, and consider the implications of changing column types on existing data and application logic.


While working on this problem, delegate to subagents for: (a) mechanical tasks such as running SQL queries, listing files, or reading XML samples (use Haiku), or (b) generating boilerplate sections of the output document (use Sonnet). Perform all analysis, schema design, migration planning, and final document writing yourself. For complex reasoning such as designing the new schema and migration steps, use Opus. 

Produce a single self-contained markdown document that captures: (1) a summary of the problem, (2) actual system (database/schema) state, and (3) the step-by-step implementation plan. This document will be used as context for further work with AI coding agents.

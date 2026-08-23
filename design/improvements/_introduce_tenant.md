Right now, ksef-exporter works for given tenant: it uses .env and reads ksef token, database connection string, etc. on start. 
Now it is able to import and work on invoices for one company/tenant.

Consider introducing multitenancy -- in the sense, that one service can interact with two ksef companies and import data from both of them into the same database.

Then the user could decide which set of data he wants to work with.
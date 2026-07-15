import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import farmersRoutes from './routes/farmers';
import plotsRoutes from './routes/plots';
import purchasingRoutes from './routes/purchasing';
import processingRoutes from './routes/processing';
import sellingRoutes from './routes/selling';
import purchaseRequestsRoutes from './routes/purchaseRequests';
import purchaseOrdersRoutes from './routes/purchaseOrders';
import paymentRequestsRoutes from './routes/paymentRequests';
import stockInRoutes from './routes/stockIn';
import documentsRoutes from './routes/documents';
import warehouseStockRoutes from './routes/warehouseStock';
import financeRoutes from './routes/finance';
import dashboardRoutes from './routes/dashboard';
import profitSharingRoutes from './routes/profitSharing';
import { distributionsRouter, installmentsRouter, outstandingRouter } from './routes/preFinance';
import { treesRouter, treeMonitoringRouter, polygonPointsRouter, mapRouter } from './routes/gis';
import {
  entitiesRouter, rolesRouter, budgetCodesRouter, unitsRouter, paymentMethodsRouter,
  preFinanceTypesRouter, sapropdiRouter, commoditiesRouter, gradesRouter, offtakersRouter,
  kthRouter, warehousesRouter, collectorsRouter, vendorsRouter, approvalRoutesRouter,
  reorderLevelsRouter, budgetsRouter,
} from './routes/masters';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Method spoofing via query (?_method=PUT|DELETE)
app.use((req, _res, next) => {
  if (req.method === 'POST' && typeof req.query._method === 'string') {
    const m = req.query._method.toUpperCase();
    if (['PUT', 'DELETE', 'PATCH'].includes(m)) req.method = m;
  }
  next();
});

// Static uploads
const uploadPath = process.env.UPLOAD_PATH || './storage/proofs';
const publicBase = process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs';
app.use(publicBase, express.static(path.resolve(uploadPath)));

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'agro-supply-api', ts: new Date().toISOString() }));

// Auth
app.use('/api', authRoutes);

// Master data
app.use('/api/entities', entitiesRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/users', usersRoutes);
app.use('/api/budget-codes', budgetCodesRouter);
app.use('/api/units', unitsRouter);
app.use('/api/payment-methods', paymentMethodsRouter);
app.use('/api/pre-finance-types', preFinanceTypesRouter);
app.use('/api/sapropdi', sapropdiRouter);
app.use('/api/commodities', commoditiesRouter);
app.use('/api/grades', gradesRouter);
app.use('/api/offtakers', offtakersRouter);
app.use('/api/kth', kthRouter);
app.use('/api/warehouses', warehousesRouter);
app.use('/api/collectors', collectorsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/approval-routes', approvalRoutesRouter);
app.use('/api/reorder-levels', reorderLevelsRouter);
app.use('/api/budgets', budgetsRouter);

// Traceability
app.use('/api/farmers', farmersRoutes);
app.use('/api/plots', plotsRoutes);
app.use('/api/purchasing', purchasingRoutes);
app.use('/api/processing', processingRoutes);
app.use('/api/selling', sellingRoutes);

// GIS / Map
app.use('/api/trees', treesRouter);
app.use('/api/tree-monitorings', treeMonitoringRouter);
app.use('/api/polygon-points', polygonPointsRouter);
app.use('/api/map', mapRouter);

// Procurement
app.use('/api/purchase-requests', purchaseRequestsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/payment-requests', paymentRequestsRoutes);
app.use('/api/stock-in', stockInRoutes);
app.use('/api/documents', documentsRoutes);

// Warehouse (calculated stock)
app.use('/api/warehouse-stock', warehouseStockRoutes);

// Pre-finance
app.use('/api/pre-finance/distributions', distributionsRouter);
app.use('/api/pre-finance/installments', installmentsRouter);
app.use('/api/pre-finance/outstanding', outstandingRouter);

// Profit sharing / Finance / Dashboard
app.use('/api/profit-sharing', profitSharingRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/dashboard', dashboardRoutes);

// 404
app.use((req, res) => res.status(404).json({ message: `Not found: ${req.method} ${req.path}` }));

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Keep the server alive if a route forgets to catch an async error.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => console.log(`✓ agro-supply-api listening on http://localhost:${PORT}`));

export default app;

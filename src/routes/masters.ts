import { crudRouter } from '../utils/crudFactory';

// Simple master-data tables, all standard CRUD behind JWT auth.

export const entitiesRouter = crudRouter({
  table: 'entities',
  columns: ['entities_name', 'location', 'username', 'password', 'is_superadmin'],
  required: ['entities_name', 'username'],
  boolean: ['is_superadmin'],
  hashColumns: ['password'],
  hideColumns: ['password'],
  searchColumns: ['entities_name', 'location', 'username'],
  label: 'Entity',
});

export const rolesRouter = crudRouter({
  table: 'roles',
  columns: ['role_name', 'is_cross_entity'],
  required: ['role_name'],
  boolean: ['is_cross_entity'],
  searchColumns: ['role_name'],
  orderBy: 'id ASC',
  label: 'Role',
});

export const budgetCodesRouter = crudRouter({
  table: 'budget_codes',
  columns: ['code', 'name', 'is_active'],
  required: ['code'],
  boolean: ['is_active'],
  searchColumns: ['code', 'name'],
  orderBy: 'code ASC',
  label: 'Budget code',
});

export const unitsRouter = crudRouter({
  table: 'units',
  columns: ['unit_name', 'symbol'],
  required: ['unit_name'],
  searchColumns: ['unit_name', 'symbol'],
  orderBy: 'unit_name ASC',
  label: 'Unit',
});

export const paymentMethodsRouter = crudRouter({
  table: 'payment_methods',
  columns: ['method_name', 'is_active'],
  required: ['method_name'],
  boolean: ['is_active'],
  orderBy: 'id ASC',
  label: 'Payment method',
});

export const preFinanceTypesRouter = crudRouter({
  table: 'pre_finance_types',
  columns: ['type_name', 'is_active'],
  required: ['type_name'],
  boolean: ['is_active'],
  orderBy: 'id ASC',
  label: 'Pre-finance type',
});

export const sapropdiRouter = crudRouter({
  table: 'sapropdi',
  columns: ['sapropdi_name', 'unit_id'],
  required: ['sapropdi_name'],
  numeric: ['unit_id'],
  searchColumns: ['sapropdi_name'],
  orderBy: 'sapropdi_name ASC',
  label: 'Sapropdi',
});

export const commoditiesRouter = crudRouter({
  table: 'commodities',
  columns: ['commodities_name'],
  required: ['commodities_name'],
  searchColumns: ['commodities_name'],
  orderBy: 'commodities_name ASC',
  label: 'Commodity',
});

export const gradesRouter = crudRouter({
  table: 'grade',
  columns: ['grade_name'],
  required: ['grade_name'],
  orderBy: 'grade_name ASC',
  label: 'Grade',
});

export const offtakersRouter = crudRouter({
  table: 'offtaker',
  columns: ['offtaker_name', 'entities_id'],
  required: ['offtaker_name'],
  numeric: ['entities_id'],
  filterColumns: ['entities_id'],
  searchColumns: ['offtaker_name'],
  orderBy: 'offtaker_name ASC',
  label: 'Offtaker',
});

export const kthRouter = crudRouter({
  table: 'kth',
  columns: ['kth_name', 'entities_id', 'username', 'password'],
  required: ['kth_name', 'entities_id'],
  numeric: ['entities_id'],
  filterColumns: ['entities_id'],
  hashColumns: ['password'],
  hideColumns: ['password'],
  searchColumns: ['kth_name', 'username'],
  label: 'KTH',
});

export const warehousesRouter = crudRouter({
  table: 'warehouse',
  columns: ['warehouse_name', 'kth_id'],
  required: ['warehouse_name'],
  numeric: ['kth_id'],
  filterColumns: ['kth_id'],
  searchColumns: ['warehouse_name'],
  orderBy: 'warehouse_name ASC',
  label: 'Warehouse',
});

export const collectorsRouter = crudRouter({
  table: 'collectors',
  columns: ['collector_name', 'kth_id'],
  required: ['collector_name'],
  numeric: ['kth_id'],
  filterColumns: ['kth_id'],
  searchColumns: ['collector_name'],
  orderBy: 'collector_name ASC',
  label: 'Collector',
});

export const vendorsRouter = crudRouter({
  table: 'vendors',
  columns: [
    'vendor_name', 'contact_person', 'phone', 'email', 'address', 'npwp',
    'bank_name', 'bank_account', 'beneficiary_name', 'category', 'status',
  ],
  required: ['vendor_name'],
  filterColumns: ['category', 'status'],
  searchColumns: ['vendor_name', 'contact_person', 'email', 'phone'],
  orderBy: 'vendor_name ASC',
  label: 'Vendor',
});

export const approvalRoutesRouter = crudRouter({
  table: 'approval_routes',
  columns: ['document_type', 'entity_id', 'step_order', 'step_label', 'role_id', 'min_amount', 'max_amount'],
  required: ['document_type', 'step_order', 'step_label', 'role_id'],
  numeric: ['entity_id', 'step_order', 'role_id', 'min_amount', 'max_amount'],
  filterColumns: ['document_type', 'entity_id'],
  orderBy: 'document_type ASC, step_order ASC',
  label: 'Approval route',
});

export const reorderLevelsRouter = crudRouter({
  table: 'saprodi_reorder_levels',
  columns: ['warehouse_id', 'sapropdi_id', 'min_stock', 'reorder_qty', 'is_active'],
  required: ['warehouse_id', 'sapropdi_id'],
  numeric: ['warehouse_id', 'sapropdi_id', 'min_stock', 'reorder_qty'],
  boolean: ['is_active'],
  filterColumns: ['warehouse_id', 'sapropdi_id'],
  label: 'Reorder level',
});

export const budgetsRouter = crudRouter({
  table: 'budgets',
  columns: ['entity_id', 'period', 'budget_code_id', 'sub_category', 'budget_amount', 'notes'],
  required: ['entity_id', 'period', 'budget_code_id'],
  numeric: ['entity_id', 'budget_code_id', 'budget_amount'],
  filterColumns: ['entity_id', 'period', 'budget_code_id'],
  label: 'Budget',
});

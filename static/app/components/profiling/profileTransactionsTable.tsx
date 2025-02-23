import {useMemo} from 'react';

import Count from 'sentry/components/count';
import DateTime from 'sentry/components/dateTime';
import GridEditable, {
  COL_WIDTH_UNDEFINED,
  GridColumnOrder,
} from 'sentry/components/gridEditable';
import ProjectBadge from 'sentry/components/idBadge/projectBadge';
import Link from 'sentry/components/links/link';
import PerformanceDuration from 'sentry/components/performanceDuration';
import {t} from 'sentry/locale';
import {ProfileTransaction} from 'sentry/types/profiling/core';
import {defined} from 'sentry/utils';
import {Container, NumberContainer} from 'sentry/utils/discover/styles';
import {generateProfileSummaryRouteWithQuery} from 'sentry/utils/profiling/routes';
import {renderTableHead} from 'sentry/utils/profiling/tableRenderer';
import {decodeScalar} from 'sentry/utils/queryString';
import {useLocation} from 'sentry/utils/useLocation';
import useOrganization from 'sentry/utils/useOrganization';
import useProjects from 'sentry/utils/useProjects';

interface ProfileTransactionsTableProps {
  error: string | null;
  isLoading: boolean;
  sort: string;
  transactions: ProfileTransaction[];
}

function ProfileTransactionsTable(props: ProfileTransactionsTableProps) {
  const location = useLocation();
  const organization = useOrganization();
  const {projects} = useProjects();

  const sort = useMemo(() => {
    let column = decodeScalar(props.sort, '-count()');
    let order: 'asc' | 'desc' = 'asc' as const;

    if (column.startsWith('-')) {
      column = column.substring(1);
      order = 'desc' as const;
    }

    if (!SORTABLE_COLUMNS.has(column as any)) {
      column = 'count()';
    }

    return {
      key: column as TableColumnKey,
      order,
    };
  }, [props.sort]);

  const transactions: TableDataRow[] = useMemo(() => {
    return props.transactions.map(transaction => {
      const project = projects.find(proj => proj.id === transaction.project_id);
      return {
        _transactionName: transaction.name,
        transaction: project ? (
          <Link
            to={generateProfileSummaryRouteWithQuery({
              query: location.query,
              orgSlug: organization.slug,
              projectSlug: project.slug,
              transaction: transaction.name,
            })}
          >
            {transaction.name}
          </Link>
        ) : (
          transaction.name
        ),
        'count()': transaction.profiles_count,
        project,
        'p50()': transaction.duration_ms.p50,
        'p75()': transaction.duration_ms.p75,
        'p90()': transaction.duration_ms.p90,
        'p95()': transaction.duration_ms.p95,
        'p99()': transaction.duration_ms.p99,
        'last_seen()': transaction.last_profile_at,
      };
    });
  }, [props.transactions, location, organization, projects]);

  const generateSortLink = (column: string) => () => {
    let dir = 'desc';
    if (column === sort.key && sort.order === dir) {
      dir = 'asc';
    }
    return {
      ...location,
      query: {
        ...location.query,
        sort: `${dir === 'desc' ? '-' : ''}${column}`,
      },
    };
  };

  return (
    <GridEditable
      isLoading={props.isLoading}
      error={props.error}
      data={transactions}
      columnOrder={COLUMN_ORDER.map(key => COLUMNS[key])}
      columnSortBy={[sort]}
      grid={{
        renderHeadCell: renderTableHead<string>({
          generateSortLink,
          sortableColumns: SORTABLE_COLUMNS,
          currentSort: sort,
          rightAlignedColumns: RIGHT_ALIGNED_COLUMNS,
        }),
        renderBodyCell: renderTableBody,
      }}
      location={location}
    />
  );
}

const RIGHT_ALIGNED_COLUMNS = new Set<TableColumnKey>([
  'count()',
  'p50()',
  'p75()',
  'p90()',
  'p95()',
  'p99()',
]);

const SORTABLE_COLUMNS = new Set<TableColumnKey>([
  'project',
  'transaction',
  'count()',
  'p50()',
  'p75()',
  'p90()',
  'p95()',
  'p99()',
  'last_seen()',
]);

function renderTableBody(
  column: GridColumnOrder,
  dataRow: TableDataRow,
  rowIndex: number,
  columnIndex: number
) {
  return (
    <ProfilingTransactionsTableCell
      column={column}
      dataRow={dataRow}
      rowIndex={rowIndex}
      columnIndex={columnIndex}
    />
  );
}

interface ProfilingTransactionsTableCellProps {
  column: GridColumnOrder;
  columnIndex: number;
  dataRow: TableDataRow;
  rowIndex: number;
}

function ProfilingTransactionsTableCell({
  column,
  dataRow,
}: ProfilingTransactionsTableCellProps) {
  const value = dataRow[column.key];

  switch (column.key) {
    case 'project':
      if (!defined(value)) {
        // should never happen but just in case
        return <Container>{t('n/a')}</Container>;
      }

      return (
        <Container>
          <ProjectBadge project={value} avatarSize={16} />
        </Container>
      );
    case 'count()':
      return (
        <NumberContainer>
          <Count value={value} />
        </NumberContainer>
      );
    case 'p50()':
    case 'p75()':
    case 'p90()':
    case 'p95()':
    case 'p99()':
      return (
        <NumberContainer>
          <PerformanceDuration milliseconds={value} abbreviation />
        </NumberContainer>
      );
    case 'last_seen()':
      return (
        <Container>
          <DateTime date={value} year seconds timeZone />
        </Container>
      );
    default:
      return <Container>{value}</Container>;
  }
}

type TableColumnKey =
  | 'transaction'
  | 'count()'
  | 'project'
  | 'p50()'
  | 'p75()'
  | 'p90()'
  | 'p95()'
  | 'p99()'
  | 'last_seen()';

type TableDataRow = Record<TableColumnKey, any>;

type TableColumn = GridColumnOrder<TableColumnKey>;

const COLUMN_ORDER: TableColumnKey[] = [
  'transaction',
  'project',
  'last_seen()',
  'p75()',
  'p95()',
  'count()',
];

const COLUMNS: Record<TableColumnKey, TableColumn> = {
  transaction: {
    key: 'transaction',
    name: t('Transaction'),
    width: COL_WIDTH_UNDEFINED,
  },
  'count()': {
    key: 'count()',
    name: t('Count'),
    width: COL_WIDTH_UNDEFINED,
  },
  project: {
    key: 'project',
    name: t('Project'),
    width: COL_WIDTH_UNDEFINED,
  },
  'p50()': {
    key: 'p50()',
    name: t('P50'),
    width: COL_WIDTH_UNDEFINED,
  },
  'p75()': {
    key: 'p75()',
    name: t('P75'),
    width: COL_WIDTH_UNDEFINED,
  },
  'p90()': {
    key: 'p90()',
    name: t('P90'),
    width: COL_WIDTH_UNDEFINED,
  },
  'p95()': {
    key: 'p95()',
    name: t('P95'),
    width: COL_WIDTH_UNDEFINED,
  },
  'p99()': {
    key: 'p99()',
    name: t('P99'),
    width: COL_WIDTH_UNDEFINED,
  },
  'last_seen()': {
    key: 'last_seen()',
    name: t('Last Seen'),
    width: COL_WIDTH_UNDEFINED,
  },
};

export {ProfileTransactionsTable};

import { computed, inject } from 'vue';
import { useRouter } from 'vue-router';
import { VIEWS } from '@/app/constants';
import { WorkflowIdKey } from '@/app/constants/injectionKeys';

export function useWorkflowId() {
	const router = useRouter();

	return computed(() => {
		const injectedWorkflowId = inject(WorkflowIdKey, null);

		if (injectedWorkflowId?.value) return injectedWorkflowId.value;

		const route = router?.currentRoute.value;

		if (!route) {
			return '';
		}

		if (route.name === VIEWS.DEMO || route.name === VIEWS.DEMO_DIFF) {
			const queryWorkflowId = route.query.workflowId;
			if (typeof queryWorkflowId === 'string' && queryWorkflowId) {
				return queryWorkflowId;
			}
			return 'demo';
		}

		const workflowId = route.params.workflowId;
		return (Array.isArray(workflowId) ? workflowId[0] : workflowId) ?? '';
	});
}

import time
from unittest import mock
from unittest.mock import patch

import pytest
from freezegun import freeze_time

from sentry.dynamic_sampling.latest_release_booster import (
    BOOSTED_RELEASE_TIMEOUT,
    get_redis_client_for_ds,
)
from sentry.dynamic_sampling.rules_generator import HEALTH_CHECK_GLOBS
from sentry.dynamic_sampling.utils import RESERVED_IDS, RuleType
from sentry.models import ProjectKey
from sentry.models.transaction_threshold import TransactionMetric
from sentry.relay.config import get_project_config
from sentry.testutils.factories import Factories
from sentry.testutils.helpers import Feature
from sentry.testutils.helpers.options import override_options
from sentry.utils.safe import get_path

PII_CONFIG = """
{
  "rules": {
    "remove_ips_and_macs": {
      "type": "multiple",
      "rules": [
        "@ip",
        "@mac"
      ],
      "hide_rule": false,
      "redaction": {
        "method": "remove"
      }
    }
  },
  "applications": {
    "$string": ["remove_ips_and_macs"]
  }
}
"""


DEFAULT_ENVIRONMENT_RULE = {
    "sampleRate": 1,
    "type": "trace",
    "condition": {
        "op": "or",
        "inner": [
            {
                "op": "glob",
                "name": "trace.environment",
                "value": ["*dev*", "*test*"],
                "options": {"ignoreCase": True},
            }
        ],
    },
    "active": True,
    "id": 1001,
}

DEFAULT_IGNORE_HEALTHCHECKS_RULE = {
    "sampleRate": 0.02,
    "type": "transaction",
    "condition": {
        "op": "or",
        "inner": [
            {
                "op": "glob",
                "name": "event.transaction",
                "value": HEALTH_CHECK_GLOBS,
                "options": {"ignoreCase": True},
            }
        ],
    },
    "active": True,
    "id": RESERVED_IDS[RuleType.IGNORE_HEALTHCHECKS_RULE],
}


@pytest.mark.django_db
@pytest.mark.parametrize("full", [False, True], ids=["slim_config", "full_config"])
def test_get_project_config(default_project, insta_snapshot, django_cache, full):
    # We could use the default_project fixture here, but we would like to avoid 1) hitting the db 2) creating a mock
    default_project.update_option("sentry:relay_pii_config", PII_CONFIG)
    default_project.organization.update_option("sentry:relay_pii_config", PII_CONFIG)
    keys = ProjectKey.objects.filter(project=default_project)

    cfg = get_project_config(default_project, full_config=full, project_keys=keys)
    cfg = cfg.to_dict()

    # Remove keys that change everytime
    cfg.pop("lastChange")
    cfg.pop("lastFetch")
    cfg.pop("rev")

    # public keys change every time
    assert cfg.pop("projectId") == default_project.id
    assert len(cfg.pop("publicKeys")) == len(keys)
    assert cfg.pop("organizationId") == default_project.organization.id

    insta_snapshot(cfg)


SOME_EXCEPTION = RuntimeError("foo")


@pytest.mark.django_db
@mock.patch("sentry.relay.config.generate_rules", side_effect=SOME_EXCEPTION)
@mock.patch("sentry.relay.config.sentry_sdk")
def test_get_experimental_config(mock_sentry_sdk, _, default_project):
    keys = ProjectKey.objects.filter(project=default_project)
    with Feature(
        {"organizations:dynamic-sampling": True, "organizations:server-side-sampling": True}
    ):
        # Does not raise:
        cfg = get_project_config(default_project, full_config=True, project_keys=keys)
    # Key is missing from config:
    assert "dynamicSampling" not in cfg.to_dict()["config"]
    assert mock_sentry_sdk.capture_exception.call_args == mock.call(SOME_EXCEPTION)


@pytest.mark.django_db
@pytest.mark.parametrize("has_custom_filters", [False, True])
def test_project_config_uses_filter_features(default_project, has_custom_filters):
    error_messages = ["some_error"]
    releases = ["1.2.3", "4.5.6"]
    default_project.update_option("sentry:error_messages", error_messages)
    default_project.update_option("sentry:releases", releases)

    with Feature({"projects:custom-inbound-filters": has_custom_filters}):
        cfg = get_project_config(default_project, full_config=True)

    cfg = cfg.to_dict()
    cfg_error_messages = get_path(cfg, "config", "filterSettings", "errorMessages")
    cfg_releases = get_path(cfg, "config", "filterSettings", "releases")

    if has_custom_filters:
        assert {"patterns": error_messages} == cfg_error_messages
        assert {"releases": releases} == cfg_releases
    else:
        assert cfg_releases is None
        assert cfg_error_messages is None


@pytest.mark.django_db
@pytest.mark.parametrize("has_dyn_sampling", [False, True])
@pytest.mark.parametrize("full_config", [False, True])
def test_project_config_uses_filters_and_sampling_feature(
    default_project, dyn_sampling_data, has_dyn_sampling, full_config
):
    """
    Tests that dynamic sampling information is retrieved for both "full config" and "restricted config"
    but only when the organization has "organizations:server-side-sampling" feature enabled.
    """
    default_project.update_option("sentry:dynamic_sampling", dyn_sampling_data())

    with Feature(
        {
            "organizations:server-side-sampling": has_dyn_sampling,
            "organizations:dynamic-sampling-deprecated": True,
        }
    ):
        cfg = get_project_config(default_project, full_config=full_config)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")

    if has_dyn_sampling:
        assert dynamic_sampling == dyn_sampling_data()
    else:
        assert dynamic_sampling is None


@pytest.mark.django_db
@pytest.mark.parametrize("active", [False, True])
def test_project_config_filters_out_non_active_rules_in_dynamic_sampling(
    default_project, dyn_sampling_data, active
):
    """
    Tests that dynamic sampling information is retrieved only for "active" rules.
    """
    default_project.update_option("sentry:dynamic_sampling", dyn_sampling_data(active))

    with Feature(
        {
            "organizations:server-side-sampling": True,
            "organizations:dynamic-sampling-deprecated": True,
        }
    ):
        cfg = get_project_config(default_project)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")

    if active:
        assert dynamic_sampling == dyn_sampling_data(active)
    else:
        assert dynamic_sampling == {"rules": []}


@pytest.mark.django_db
def test_project_config_dynamic_sampling_is_none(default_project):
    """
    Tests test check inc-237 that dynamic sampling is None,
    so it's pass when we have fix and fails when we dont
    """
    default_project.update_option("sentry:dynamic_sampling", None)

    with Feature(
        {
            "organizations:server-side-sampling": True,
            "organizations:dynamic-sampling-deprecated": True,
        }
    ):
        cfg = get_project_config(default_project)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")

    assert dynamic_sampling is None


@pytest.mark.django_db
def test_project_config_with_latest_release_in_dynamic_sampling_rules(default_project):
    """
    Tests that dynamic sampling information return correct release instead of alias "latest"
    """
    dynamic_sampling_data = {
        "rules": [
            {
                "sampleRate": 0.7,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [
                        {"op": "glob", "name": "trace.release", "value": ["latest"]},
                    ],
                },
            },
            {
                "sampleRate": 0.1,
                "type": "trace",
                "condition": {"op": "and", "inner": []},
                "active": True,
                "id": 1,
            },
        ]
    }

    default_project.update_option("sentry:dynamic_sampling", dynamic_sampling_data)
    release = Factories.create_release(
        project=default_project,
        version="backend@22.9.0.dev0+8291ce47cf95d8c14d70af8fde7449b61319c1a4",
    )
    with Feature(
        {
            "organizations:server-side-sampling": True,
            "organizations:dynamic-sampling-deprecated": True,
        }
    ):
        cfg = get_project_config(default_project)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")
    assert dynamic_sampling["rules"][0]["condition"]["inner"] == [
        {"op": "glob", "name": "trace.release", "value": [release.version]}
    ]
    assert dynamic_sampling["rules"][1]["condition"]["inner"] == []


@pytest.mark.django_db
@pytest.mark.parametrize(
    "ss_sampling,ds_basic,current_ds_data,expected",
    [
        # server-side-sampling: True, dynamic-sampling: True
        # `dynamic-sampling` flag has the highest precedence
        (
            True,
            True,
            {"rules": []},
            {
                "rules": [
                    DEFAULT_ENVIRONMENT_RULE,
                    DEFAULT_IGNORE_HEALTHCHECKS_RULE,
                    {
                        "sampleRate": 0.1,
                        "type": "trace",
                        "active": True,
                        "condition": {"op": "and", "inner": []},
                        "id": 1000,
                    },
                ]
            },
        ),
        (
            True,
            True,
            {
                "rules": [
                    {
                        "sampleRate": 0.1,
                        "type": "trace",
                        "active": True,
                        "condition": {"op": "and", "inner": []},
                        "id": 1000,
                    }
                ]
            },
            {
                "rules": [
                    DEFAULT_ENVIRONMENT_RULE,
                    DEFAULT_IGNORE_HEALTHCHECKS_RULE,
                    {
                        "sampleRate": 0.1,
                        "type": "trace",
                        "active": True,
                        "condition": {"op": "and", "inner": []},
                        "id": 1000,
                    },
                ]
            },
        ),
        (
            True,
            False,
            {"rules": []},
            {"rules": []},
        ),
        (
            True,
            True,
            {"rules": []},
            {
                "rules": [
                    DEFAULT_ENVIRONMENT_RULE,
                    DEFAULT_IGNORE_HEALTHCHECKS_RULE,
                    {
                        "sampleRate": 0.1,
                        "type": "trace",
                        "active": True,
                        "condition": {"op": "and", "inner": []},
                        "id": 1000,
                    },
                ]
            },
        ),
        (False, False, {"rules": []}, None),
    ],
)
def test_project_config_with_uniform_rules_based_on_plan_in_dynamic_sampling_rules(
    default_project, ss_sampling, ds_basic, current_ds_data, expected
):
    """
    Tests that dynamic sampling information return correct uniform rules
    """
    default_project.update_option("sentry:dynamic_sampling", current_ds_data)
    with Feature(
        {
            "organizations:server-side-sampling": ss_sampling,
            "organizations:dynamic-sampling": ds_basic,
            "organizations:dynamic-sampling-deprecated": True,
        }
    ):
        with mock.patch(
            "sentry.dynamic_sampling.rules_generator.quotas.get_blended_sample_rate",
            return_value=0.1,
        ):
            cfg = get_project_config(default_project)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")
    assert dynamic_sampling == expected


@pytest.mark.django_db
@freeze_time("2022-10-21 18:50:25.000000+00:00")
@mock.patch("sentry.dynamic_sampling.rules_generator.BOOSTED_RELEASES_LIMIT", 5)
def test_project_config_with_boosted_latest_releases_boost_in_dynamic_sampling_rules(
    default_project,
):
    """
    Tests that dynamic sampling information return correct uniform rules
    """
    redis_client = get_redis_client_for_ds()
    ts = time.time()

    release_ids = []
    for release_version in ("1.0", "2.0", "3.0", "4.0", "5.0", "6.0", "7.0"):
        release = Factories.create_release(
            project=default_project,
            version=release_version,
        )
        release_ids.append(release.id)

    boosted_releases = [[release_ids[0], ts - BOOSTED_RELEASE_TIMEOUT * 2]]
    for release_id in release_ids[1:]:
        boosted_releases.append([release_id, ts])

    for release, timestamp in boosted_releases:
        redis_client.hset(
            f"ds::p:{default_project.id}:boosted_releases",
            release,
            timestamp,
        )
    with Feature(
        {
            "organizations:server-side-sampling": True,
            "organizations:dynamic-sampling": True,
        }
    ):
        with patch(
            "sentry.dynamic_sampling.rules_generator.quotas.get_blended_sample_rate",
            return_value=0.1,
        ):
            cfg = get_project_config(default_project)

    cfg = cfg.to_dict()
    dynamic_sampling = get_path(cfg, "config", "dynamicSampling")
    assert dynamic_sampling == {
        "rules": [
            {
                "sampleRate": 1,
                "type": "trace",
                "condition": {
                    "op": "or",
                    "inner": [
                        {
                            "op": "glob",
                            "name": "trace.environment",
                            "value": ["*dev*", "*test*"],
                            "options": {"ignoreCase": True},
                        }
                    ],
                },
                "active": True,
                "id": 1001,
            },
            {
                "sampleRate": 0.02,
                "type": "transaction",
                "condition": {
                    "op": "or",
                    "inner": [
                        {
                            "op": "glob",
                            "name": "event.transaction",
                            "value": HEALTH_CHECK_GLOBS,
                            "options": {"ignoreCase": True},
                        }
                    ],
                },
                "active": True,
                "id": 1002,
            },
            {
                "sampleRate": 0.5,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [{"op": "glob", "name": "trace.release", "value": ["3.0"]}],
                },
                "id": 1500,
                "timeRange": {
                    "start": "2022-10-21 18:50:25+00:00",
                    "end": "2022-10-21 19:50:25+00:00",
                },
            },
            {
                "sampleRate": 0.5,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [{"op": "glob", "name": "trace.release", "value": ["4.0"]}],
                },
                "id": 1501,
                "timeRange": {
                    "start": "2022-10-21 18:50:25+00:00",
                    "end": "2022-10-21 19:50:25+00:00",
                },
            },
            {
                "sampleRate": 0.5,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [{"op": "glob", "name": "trace.release", "value": ["5.0"]}],
                },
                "id": 1502,
                "timeRange": {
                    "start": "2022-10-21 18:50:25+00:00",
                    "end": "2022-10-21 19:50:25+00:00",
                },
            },
            {
                "sampleRate": 0.5,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [{"op": "glob", "name": "trace.release", "value": ["6.0"]}],
                },
                "id": 1503,
                "timeRange": {
                    "start": "2022-10-21 18:50:25+00:00",
                    "end": "2022-10-21 19:50:25+00:00",
                },
            },
            {
                "sampleRate": 0.5,
                "type": "trace",
                "active": True,
                "condition": {
                    "op": "and",
                    "inner": [{"op": "glob", "name": "trace.release", "value": ["7.0"]}],
                },
                "id": 1504,
                "timeRange": {
                    "start": "2022-10-21 18:50:25+00:00",
                    "end": "2022-10-21 19:50:25+00:00",
                },
            },
            {
                "sampleRate": 0.1,
                "type": "trace",
                "active": True,
                "condition": {"op": "and", "inner": []},
                "id": 1000,
            },
        ]
    }


@pytest.mark.django_db
@pytest.mark.parametrize("transaction_metrics", ("with_metrics", "without_metrics"))
def test_project_config_with_breakdown(default_project, insta_snapshot, transaction_metrics):
    with Feature(
        {
            "organizations:transaction-metrics-extraction": transaction_metrics == "with_metrics",
        }
    ):
        cfg = get_project_config(default_project, full_config=True)

    cfg = cfg.to_dict()
    insta_snapshot(
        {
            "breakdownsV2": cfg["config"]["breakdownsV2"],
            "transactionMetrics": cfg["config"].get("transactionMetrics"),
            "metricConditionalTagging": cfg["config"].get("metricConditionalTagging"),
        }
    )


@pytest.mark.django_db
@pytest.mark.parametrize("has_project_transaction_threshold", (False, True))
@pytest.mark.parametrize("has_project_transaction_threshold_overrides", (False, True))
def test_project_config_satisfaction_thresholds(
    default_project,
    insta_snapshot,
    has_project_transaction_threshold_overrides,
    has_project_transaction_threshold,
):
    if has_project_transaction_threshold:
        default_project.projecttransactionthreshold_set.create(
            organization=default_project.organization,
            threshold=500,
            metric=TransactionMetric.LCP.value,
        )
    if has_project_transaction_threshold_overrides:
        default_project.projecttransactionthresholdoverride_set.create(
            organization=default_project.organization,
            transaction="foo",
            threshold=400,
            metric=TransactionMetric.DURATION.value,
        )
        default_project.projecttransactionthresholdoverride_set.create(
            organization=default_project.organization,
            transaction="bar",
            threshold=600,
            metric=TransactionMetric.LCP.value,
        )
    with Feature(
        {
            "organizations:transaction-metrics-extraction": True,
        }
    ):
        cfg = get_project_config(default_project, full_config=True)

    cfg = cfg.to_dict()
    insta_snapshot(cfg["config"]["metricConditionalTagging"])


@pytest.mark.django_db
def test_project_config_with_span_attributes(default_project, insta_snapshot):
    # The span attributes config is not set with the flag turnd off
    cfg = get_project_config(default_project, full_config=True)
    cfg = cfg.to_dict()
    insta_snapshot(cfg["config"]["spanAttributes"])


@pytest.mark.django_db
@pytest.mark.parametrize("feature_flag", (False, True), ids=("feature_disabled", "feature_enabled"))
@pytest.mark.parametrize("org_sample", (0.0, 1.0), ids=("no_orgs", "all_orgs"))
@pytest.mark.parametrize(
    "killswitch", (False, True), ids=("killswitch_disabled", "killswitch_enabled")
)
def test_has_metric_extraction(default_project, feature_flag, org_sample, killswitch):
    options = override_options(
        {
            "relay.drop-transaction-metrics": [{"project_id": default_project.id}]
            if killswitch
            else [],
            "relay.transaction-metrics-org-sample-rate": org_sample,
        }
    )
    feature = Feature(
        {
            "organizations:transaction-metrics-extraction": feature_flag,
        }
    )
    with feature, options:
        config = get_project_config(default_project)
        if killswitch or (org_sample == 0.0 and not feature_flag):
            assert "transactionMetrics" not in config.to_dict()["config"]
        else:
            config = config.to_dict()["config"]["transactionMetrics"]
            assert config["extractMetrics"]
            assert config["customMeasurements"]["limit"] > 0


@pytest.mark.django_db
@pytest.mark.parametrize("org_sample", (0.0, 1.0), ids=("no_orgs", "all_orgs"))
def test_accept_transaction_names(default_project, org_sample):
    options = override_options(
        {
            "relay.transaction-names-client-based": org_sample,
        }
    )
    feature = Feature(
        {
            "organizations:transaction-metrics-extraction": True,
        }
    )
    with feature, options:
        config = get_project_config(default_project).to_dict()["config"]
        transaction_metrics_config = config["transactionMetrics"]
        assert (
            transaction_metrics_config["acceptTransactionNames"] == "clientBased"
            if org_sample
            else "strict"
        )

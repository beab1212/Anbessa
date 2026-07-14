# k8s/base

One Deployment + Service + HPA template (shown for trip-service). In
practice you'd generate one set of these per service — they're identical in
shape, only name/image/port/resources differ — either by copy-paste or with a
Helm chart / kustomize component if the duplication gets annoying.

`overlays/staging` and `overlays/production` patch replica counts and resource
limits per environment without duplicating the base manifests.

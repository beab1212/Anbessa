# k8s/base

One Deployment + Service + HPA template (shown for trip-service). In
practice you'd generate one set of these per service — they're identical in
shape, only name/image/port/resources differ — either by copy-paste or with a
Helm chart / kustomize component if the duplication gets annoying.

pricing-service is the first copy: `pricing-service.{deployment,service,hpa}.yaml`
(ConfigMap `pricing-service-config`, Secret `pricing-service-secrets` with `DATABASE_URL`; see
`infra/docs/kubernetes.md` §3 for the variables).

Images are built by `.github/workflows/deploy.yml` from each service's
`Dockerfile`, using the repo root as build context (Node 24 alpine, pnpm
`deploy --prod`). They're tagged `registry.example.com/ride-app/<svc>:<git sha>`.

`overlays/staging` and `overlays/production` patch replica counts and resource
limits per environment without duplicating the base manifests.
